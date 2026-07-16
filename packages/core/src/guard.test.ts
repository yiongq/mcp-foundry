import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MemoryAuditLogger } from './audit.js';
import { Guard } from './guard.js';
import { loadRbacConfig } from './rbac.js';
import type { Principal, SystemAdapter } from './types.js';

const EMPLOYEES = [
  { employee_id: 'e001', name: '张三', dept: '生产部', salary: 18500, leave_days: 4 },
  { employee_id: 'e002', name: '小王', dept: '行政部', salary: 9800, leave_days: 7 },
];

const fakeHr: SystemAdapter = {
  system: 'fake-hr',
  tools: () => [
    { name: 'list_employees', description: '员工列表', inputSchema: z.object({}) },
    { name: 'get_salary', description: '查薪资', inputSchema: z.object({ id: z.string() }) },
  ],
  execute: async (call) => {
    if (call.tool === 'list_employees') return { data: EMPLOYEES };
    if (call.tool === 'get_salary') {
      return { data: EMPLOYEES.find((e) => e.employee_id === call.args.id) ?? null };
    }
    throw new Error(`unknown tool: ${call.tool}`);
  },
};

const rbac = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees]
    rows:
      - field: employee_id
        equals: $self.userId
    mask: [salary]
  hr_admin:
    tools: "*"
`);

const XIAO_WANG: Principal = { userId: 'e002', role: 'employee' };
const LAO_LI: Principal = { userId: 'e009', role: 'hr_admin' };

describe('守卫管线', () => {
  it('越权工具：员工查薪资 → 结构化拒答，且拒答分支不含 data 字段', async () => {
    const audit = new MemoryAuditLogger();
    const guard = new Guard(rbac, audit);

    const result = await guard.invoke(fakeHr, XIAO_WANG, {
      tool: 'get_salary',
      args: { id: 'e001' },
    });

    expect(result.kind).toBe('refusal');
    expect(result).not.toHaveProperty('data');
    expect(audit.events[0]?.decision).toBe('DENY');
    expect(audit.events[0]?.reason).toBe('tool_not_allowed');
  });

  it('行级过滤：员工列表只剩自己那一行', async () => {
    const guard = new Guard(rbac, new MemoryAuditLogger());

    const result = await guard.invoke(fakeHr, XIAO_WANG, { tool: 'list_employees', args: {} });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data).toHaveLength(1);
    expect((result.data as Record<string, unknown>[])[0]?.name).toBe('小王');
  });

  it('字段脱敏：员工可见行里 salary 被抹除', async () => {
    const guard = new Guard(rbac, new MemoryAuditLogger());

    const result = await guard.invoke(fakeHr, XIAO_WANG, { tool: 'list_employees', args: {} });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const row = (result.data as Record<string, unknown>[])[0];
    expect(row).not.toHaveProperty('salary');
    expect(row).toHaveProperty('leave_days');
  });

  it('HR 管理员：同一问题放行且薪资可见，审计记 ALLOW', async () => {
    const audit = new MemoryAuditLogger();
    const guard = new Guard(rbac, audit);

    const result = await guard.invoke(fakeHr, LAO_LI, { tool: 'get_salary', args: { id: 'e001' } });

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect((result.data as Record<string, unknown>).salary).toBe(18500);
    expect(audit.events[0]?.decision).toBe('ALLOW');
  });

  it('未知角色 → 拒答；tools/list 对未知角色返回空', async () => {
    const guard = new Guard(rbac, new MemoryAuditLogger());
    const ghost: Principal = { userId: 'x', role: 'ghost' };

    const result = await guard.invoke(fakeHr, ghost, { tool: 'list_employees', args: {} });

    expect(result.kind).toBe('refusal');
    if (result.kind !== 'refusal') return;
    expect(result.reason).toBe('unknown_role');
    expect(guard.allowedTools(fakeHr, ghost)).toHaveLength(0);
  });

  it('tools/list 按角色收窄：员工看不到 get_salary', () => {
    const guard = new Guard(rbac, new MemoryAuditLogger());

    const names = guard.allowedTools(fakeHr, XIAO_WANG).map((t) => t.name);

    expect(names).toEqual(['list_employees']);
  });

  it('zod 校验错误被压成人话——error 分支不透传 code/expected 等内部字段', async () => {
    const strictInput = z.object({ employee_id: z.string().min(1) });
    const picky: SystemAdapter = {
      system: 'picky',
      tools: () => [{ name: 'lookup', description: 'lookup', inputSchema: strictInput }],
      execute: async (call) => {
        strictInput.parse(call.args);
        return { data: null };
      },
    };
    const guard = new Guard(rbac, new MemoryAuditLogger());

    const result = await guard.invoke(picky, LAO_LI, { tool: 'lookup', args: {} });

    expect(result.kind).toBe('error');
    if (result.kind !== 'error') return;
    expect(result.message).toContain('参数校验失败');
    expect(result.message).toContain('employee_id');
    // zod 原始 issue 转储的内部字段不得出现
    expect(result.message).not.toContain('"code"');
    expect(result.message).not.toContain('invalid_type');
  });

  it('适配器抛错 → error 分支，不夹带业务数据，审计记 ERROR', async () => {
    const audit = new MemoryAuditLogger();
    const guard = new Guard(rbac, audit);

    const result = await guard.invoke(fakeHr, LAO_LI, { tool: 'boom', args: {} });

    expect(result.kind).toBe('error');
    expect(result).not.toHaveProperty('data');
    expect(audit.events[0]?.decision).toBe('ERROR');
  });

  it('principal 透传给适配器 execute——写入类工具据此盖归属戳', async () => {
    const seen: Principal[] = [];
    const probe: SystemAdapter = {
      system: 'probe',
      tools: () => [{ name: 'echo', description: 'echo', inputSchema: z.object({}) }],
      execute: async (_call, principal) => {
        seen.push(principal);
        return { data: null };
      },
    };
    const guard = new Guard(rbac, new MemoryAuditLogger());

    await guard.invoke(probe, LAO_LI, { tool: 'echo', args: {} });

    expect(seen).toEqual([LAO_LI]);
  });

  it('ablation：关 rbac 后请求穿过白名单层，被行级过滤这道后备拦住（原因变 row_denied）', async () => {
    const guard = new Guard(rbac, new MemoryAuditLogger(), { disabledLayers: ['rbac'] });

    const result = await guard.invoke(fakeHr, XIAO_WANG, {
      tool: 'get_salary',
      args: { id: 'e001' },
    });

    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') expect(result.reason).toBe('row_denied');
    expect(guard.allowedTools(fakeHr, { userId: 'x', role: 'ghost' })).toHaveLength(2);
  });

  it('ablation：关 row_filter 后员工能看到全员行；关 field_mask 后 salary 复现', async () => {
    const noRows = new Guard(rbac, new MemoryAuditLogger(), { disabledLayers: ['row_filter'] });
    const listAll = await noRows.invoke(fakeHr, XIAO_WANG, { tool: 'list_employees', args: {} });
    expect(listAll.kind).toBe('ok');
    if (listAll.kind === 'ok') {
      expect(listAll.data).toHaveLength(2);
      // 行级关了但脱敏还在
      expect((listAll.data as Record<string, unknown>[])[0]).not.toHaveProperty('salary');
    }

    const noMask = new Guard(rbac, new MemoryAuditLogger(), { disabledLayers: ['field_mask'] });
    const listSelf = await noMask.invoke(fakeHr, XIAO_WANG, { tool: 'list_employees', args: {} });
    expect(listSelf.kind).toBe('ok');
    if (listSelf.kind === 'ok') {
      expect(listSelf.data).toHaveLength(1);
      expect((listSelf.data as Record<string, unknown>[])[0]?.salary).toBe(9800);
      expect(listSelf.maskedFields).toEqual([]);
    }
  });

  it('ablation：全关 = 裸奔，未知角色也能拿到全员含薪资', async () => {
    const guard = new Guard(rbac, new MemoryAuditLogger(), {
      disabledLayers: ['rbac', 'row_filter', 'field_mask'],
    });

    const result = await guard.invoke(
      fakeHr,
      { userId: 'x', role: 'ghost' },
      { tool: 'list_employees', args: {} },
    );

    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data).toHaveLength(2);
    expect((result.data as Record<string, unknown>[])[0]?.salary).toBe(18500);
  });

  it('$self.attrs 引用解析失败时宁可错拒：单对象查询被拒绝', async () => {
    const strictRbac = loadRbacConfig(`
roles:
  dept_lead:
    tools: "*"
    rows:
      - field: dept
        equals: $self.attrs.dept
`);
    const guard = new Guard(strictRbac, new MemoryAuditLogger());
    const leadWithoutDept: Principal = { userId: 'e100', role: 'dept_lead' };

    const result = await guard.invoke(fakeHr, leadWithoutDept, {
      tool: 'get_salary',
      args: { id: 'e001' },
    });

    expect(result.kind).toBe('refusal');
    if (result.kind !== 'refusal') return;
    expect(result.reason).toBe('row_denied');
  });
});
