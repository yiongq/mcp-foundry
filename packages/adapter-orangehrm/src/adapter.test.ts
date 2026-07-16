import { readFile } from 'node:fs/promises';
import type { Principal } from '@yiong/foundry-core';
import { Guard, loadRbacConfig, MemoryAuditLogger } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { createOrangeHrmAdapter } from './adapter.js';

// env: {} 保证测试不受本机 ORANGEHRM_* 环境变量影响，始终走 fixture
const adapter = createOrangeHrmAdapter({ env: {} });

describe('fixture 模式：四个工具', () => {
  it('tools() 恰好 4 个，名称与顺序稳定', () => {
    expect(adapter.system).toBe('orangehrm');
    expect(adapter.tools().map((t) => t.name)).toEqual([
      'list_employees',
      'get_employee',
      'get_leave_balance',
      'get_salary',
    ]);
  });

  it('list_employees 无参 → 6 人，行结构不夹带 salary/phone', async () => {
    const { data } = await adapter.execute({ tool: 'list_employees', args: {} });
    expect(data).toHaveLength(6);
    const first = (data as Record<string, unknown>[])[0];
    expect(first).toEqual({
      employee_id: 'e001',
      name: '张三',
      dept: '生产部',
      title: '设备工程师',
    });
  });

  it('list_employees dept 过滤：生产部只剩张三和李四', async () => {
    const { data } = await adapter.execute({ tool: 'list_employees', args: { dept: '生产部' } });
    const ids = (data as { employee_id: string }[]).map((r) => r.employee_id);
    expect(ids).toEqual(['e001', 'e003']);
  });

  it('list_employees dept 不存在 → 空数组而非报错', async () => {
    const { data } = await adapter.execute({ tool: 'list_employees', args: { dept: '不存在部' } });
    expect(data).toEqual([]);
  });

  it('get_employee 命中 → 含 email/phone 的完整行', async () => {
    const { data } = await adapter.execute({ tool: 'get_employee', args: { employee_id: 'e002' } });
    expect(data).toEqual({
      employee_id: 'e002',
      name: '小王',
      dept: '行政部',
      title: '行政专员',
      email: 'xiaowang@example.com',
      phone: '13800000002',
    });
  });

  it('get_leave_balance：annual_left = total - used', async () => {
    const { data } = await adapter.execute({
      tool: 'get_leave_balance',
      args: { employee_id: 'e001' },
    });
    expect(data).toEqual({
      employee_id: 'e001',
      name: '张三',
      annual_total: 10,
      annual_used: 6,
      annual_left: 4,
    });
  });

  it('get_salary：金额/币种/生效日期符合 fixture 契约', async () => {
    const { data } = await adapter.execute({ tool: 'get_salary', args: { employee_id: 'e004' } });
    expect(data).toEqual({
      employee_id: 'e004',
      name: '老李',
      salary: 22000,
      currency: 'CNY',
      effective_date: '2026-01-01',
    });
  });

  it('不存在的 employee_id：三个单查工具都返回 null', async () => {
    for (const tool of ['get_employee', 'get_leave_balance', 'get_salary']) {
      const { data } = await adapter.execute({ tool, args: { employee_id: 'e999' } });
      expect(data).toBeNull();
    }
  });

  it('参数校验：缺 employee_id / 类型不对 → 抛错（由守卫归一为 error 分支）', async () => {
    await expect(adapter.execute({ tool: 'get_employee', args: {} })).rejects.toThrow();
    await expect(
      adapter.execute({ tool: 'get_salary', args: { employee_id: 42 } }),
    ).rejects.toThrow();
  });

  it('未知工具 → 抛错', async () => {
    await expect(adapter.execute({ tool: 'fire_employee', args: {} })).rejects.toThrow();
  });
});

describe('config/rbac.orangehrm.yaml 与守卫联动', () => {
  const XIAO_WANG: Principal = { userId: 'e002', role: 'employee' };
  const LAO_LI: Principal = { userId: 'e004', role: 'hr_admin' };

  async function loadGuard(): Promise<Guard> {
    const yamlText = await readFile(
      new URL('../../../config/rbac.orangehrm.yaml', import.meta.url),
      'utf8',
    );
    return new Guard(loadRbacConfig(yamlText), new MemoryAuditLogger());
  }

  it('小王查自己：get_employee 放行但 phone 被脱敏', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, XIAO_WANG, {
      tool: 'get_employee',
      args: { employee_id: 'e002' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data).toHaveProperty('email');
    expect(result.data).not.toHaveProperty('phone');
  });

  it('小王查别人：行级规则拒绝', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, XIAO_WANG, {
      tool: 'get_employee',
      args: { employee_id: 'e001' },
    });
    expect(result.kind).toBe('refusal');
    if (result.kind !== 'refusal') return;
    expect(result.reason).toBe('row_denied');
  });

  it('小王查薪资：工具白名单拒绝', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, XIAO_WANG, {
      tool: 'get_salary',
      args: { employee_id: 'e002' },
    });
    expect(result.kind).toBe('refusal');
    if (result.kind !== 'refusal') return;
    expect(result.reason).toBe('tool_not_allowed');
  });

  it('老李（hr_admin）查任意人薪资：放行且数字完整', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, LAO_LI, {
      tool: 'get_salary',
      args: { employee_id: 'e001' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect((result.data as Record<string, unknown>).salary).toBe(18500);
  });
});

describe('REST 模式接线（mock fetch，不发真实请求）', () => {
  it('给了 rest 配置即走 REST：先取 token，再映射员工列表', async () => {
    const calls: string[] = [];
    const fakeFetch: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes('/oauth2/token')) {
        return Response.json({ access_token: 't-123', token_type: 'Bearer', expires_in: 3600 });
      }
      if (url.includes('/api/v2/pim/employees')) {
        return Response.json({
          data: [
            {
              empNumber: 7,
              employeeId: 'e001',
              firstName: '张三',
              middleName: null,
              lastName: null,
              jobTitle: { title: '设备工程师' },
              subunit: { id: 2, name: '生产部' },
            },
          ],
          meta: { total: 1 },
        });
      }
      return new Response('not found', { status: 404 });
    };

    const restAdapter = createOrangeHrmAdapter({
      env: {},
      rest: {
        baseUrl: 'http://hr.local/',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        fetchImpl: fakeFetch,
      },
    });

    const { data } = await restAdapter.execute({ tool: 'list_employees', args: {} });
    expect(data).toEqual([
      { employee_id: 'e001', name: '张三', dept: '生产部', title: '设备工程师' },
    ]);
    expect(calls[0]).toBe('http://hr.local/web/index.php/oauth2/token');
    expect(calls[1]).toContain('/web/index.php/api/v2/pim/employees');
  });
});
