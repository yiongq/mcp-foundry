import { readFile } from 'node:fs/promises';
import type { Principal } from '@yiong/foundry-core';
import { Guard, loadRbacConfig, MemoryAuditLogger } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { createEspoCrmAdapter } from './adapter.js';

// env: {} 保证测试不受本机 ESPOCRM_* 环境变量影响，始终走 fixture
const adapter = createEspoCrmAdapter({ env: {} });
// 直调 execute 需要身份占位——espocrm 适配器不读它（权限在守卫层），传谁都一样
const CALLER: Principal = { userId: 'e000', role: 'test' };

describe('fixture 模式：七个工具', () => {
  it('tools() 恰好 7 个，名称与顺序稳定', () => {
    expect(adapter.system).toBe('espocrm');
    expect(adapter.tools().map((t) => t.name)).toEqual([
      'list_accounts',
      'get_account',
      'list_contacts',
      'get_contact',
      'list_opportunities',
      'get_opportunity',
      'get_pipeline_summary',
    ]);
  });

  it('list_accounts 无参 → 5 家客户，列表行不夹带 phone/website', async () => {
    const { data } = await adapter.execute({ tool: 'list_accounts', args: {} }, CALLER);
    expect(data).toHaveLength(5);
    const first = (data as Record<string, unknown>[])[0];
    expect(first).toEqual({
      account_id: 'a001',
      name: '华胜精密制造',
      industry: '制造业',
      owner_id: 'e007',
    });
  });

  it('list_accounts industry 过滤：制造业只剩华胜', async () => {
    const { data } = await adapter.execute(
      { tool: 'list_accounts', args: { industry: '制造业' } },
      CALLER,
    );
    const ids = (data as { account_id: string }[]).map((r) => r.account_id);
    expect(ids).toEqual(['a001']);
  });

  it('get_account 命中 → 含 website/phone/city 的完整行', async () => {
    const { data } = await adapter.execute(
      { tool: 'get_account', args: { account_id: 'a003' } },
      CALLER,
    );
    expect(data).toEqual({
      account_id: 'a003',
      name: '启明软件',
      industry: '软件',
      owner_id: 'e008',
      website: 'www.qiming.example.com',
      phone: '0571-88003003',
      city: '杭州',
    });
  });

  it('list_contacts：无参 5 行、按 account_id 过滤、列表行不夹带 email/phone', async () => {
    const { data: all } = await adapter.execute({ tool: 'list_contacts', args: {} }, CALLER);
    expect(all).toHaveLength(5);
    const first = (all as Record<string, unknown>[])[0];
    expect(first).toEqual({
      contact_id: 'c001',
      name: '陈建国',
      title: '采购总监',
      account_id: 'a001',
      owner_id: 'e007',
    });

    const { data: filtered } = await adapter.execute(
      { tool: 'list_contacts', args: { account_id: 'a003' } },
      CALLER,
    );
    expect((filtered as { contact_id: string }[]).map((c) => c.contact_id)).toEqual(['c003']);
  });

  it('get_contact 命中 → 联系人带所属客户与归属销售', async () => {
    const { data } = await adapter.execute(
      { tool: 'get_contact', args: { contact_id: 'c001' } },
      CALLER,
    );
    expect(data).toEqual({
      contact_id: 'c001',
      name: '陈建国',
      title: '采购总监',
      account_id: 'a001',
      owner_id: 'e007',
      email: 'chenjianguo@huasheng.example.com',
      phone: '13900001001',
    });
  });

  it('list_opportunities stage 过滤：Proposal 两单', async () => {
    const { data } = await adapter.execute(
      { tool: 'list_opportunities', args: { stage: 'Proposal' } },
      CALLER,
    );
    const ids = (data as { opportunity_id: string }[]).map((r) => r.opportunity_id);
    expect(ids).toEqual(['o001', 'o005']);
  });

  it('get_opportunity：金额/币种/阶段符合 fixture 契约', async () => {
    const { data } = await adapter.execute(
      { tool: 'get_opportunity', args: { opportunity_id: 'o001' } },
      CALLER,
    );
    expect(data).toEqual({
      opportunity_id: 'o001',
      name: '华胜产线扩建设备采购',
      account_id: 'a001',
      stage: 'Proposal',
      amount: 480000,
      currency: 'CNY',
      probability: 60,
      close_date: '2026-09-30',
      owner_id: 'e007',
    });
  });

  it('get_pipeline_summary：汇总从明细现算，两位销售各一行', async () => {
    const { data } = await adapter.execute({ tool: 'get_pipeline_summary', args: {} }, CALLER);
    expect(data).toEqual([
      {
        owner_id: 'e007',
        owner_name: '孙七',
        open_count: 3,
        open_amount: 1465000,
        won_count: 0,
        won_amount: 0,
      },
      {
        owner_id: 'e008',
        owner_name: '周八',
        open_count: 1,
        open_amount: 98000,
        won_count: 1,
        won_amount: 150000,
      },
    ]);
  });

  it('不存在的 id：三个单查工具都返回 null', async () => {
    const misses: Array<[string, Record<string, unknown>]> = [
      ['get_account', { account_id: 'a999' }],
      ['get_contact', { contact_id: 'c999' }],
      ['get_opportunity', { opportunity_id: 'o999' }],
    ];
    for (const [tool, args] of misses) {
      const { data } = await adapter.execute({ tool, args }, CALLER);
      expect(data).toBeNull();
    }
  });

  it('参数校验：缺 id / 类型不对 / 空字符串 → 抛错（由守卫归一为 error 分支）', async () => {
    await expect(adapter.execute({ tool: 'get_account', args: {} }, CALLER)).rejects.toThrow();
    await expect(
      adapter.execute({ tool: 'get_opportunity', args: { opportunity_id: 42 } }, CALLER),
    ).rejects.toThrow();
    await expect(
      adapter.execute({ tool: 'list_opportunities', args: { stage: '' } }, CALLER),
    ).rejects.toThrow();
  });

  it('未知工具 → 抛错', async () => {
    await expect(adapter.execute({ tool: 'delete_account', args: {} }, CALLER)).rejects.toThrow();
  });
});

describe('config/rbac.espocrm.yaml 与守卫联动', () => {
  const SUN_QI: Principal = { userId: 'e007', role: 'sales_rep' };
  const WANG_WU: Principal = { userId: 'e005', role: 'sales_manager' };

  async function loadGuard(): Promise<Guard> {
    const yamlText = await readFile(
      new URL('../../../config/rbac.espocrm.yaml', import.meta.url),
      'utf8',
    );
    return new Guard(loadRbacConfig(yamlText), new MemoryAuditLogger());
  }

  it('孙七拉客户列表：只见自己的 3 家', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, SUN_QI, { tool: 'list_accounts', args: {} });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect((result.data as { account_id: string }[]).map((r) => r.account_id)).toEqual([
      'a001',
      'a002',
      'a005',
    ]);
  });

  it('孙七拉联系人列表：只见自己名下 3 人', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, SUN_QI, { tool: 'list_contacts', args: {} });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect((result.data as { contact_id: string }[]).map((c) => c.contact_id)).toEqual([
      'c001',
      'c002',
      'c005',
    ]);
  });

  it('孙七查自己客户的联系人：放行但 phone 被脱敏', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, SUN_QI, {
      tool: 'get_contact',
      args: { contact_id: 'c001' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.data).toHaveProperty('email');
    expect(result.data).not.toHaveProperty('phone');
  });

  it('孙七查周八的商机：行级规则拒绝', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, SUN_QI, {
      tool: 'get_opportunity',
      args: { opportunity_id: 'o003' },
    });
    expect(result.kind).toBe('refusal');
    if (result.kind !== 'refusal') return;
    expect(result.reason).toBe('row_denied');
  });

  it('孙七清点全员业绩盘：工具白名单拒绝', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, SUN_QI, {
      tool: 'get_pipeline_summary',
      args: {},
    });
    expect(result.kind).toBe('refusal');
    if (result.kind !== 'refusal') return;
    expect(result.reason).toBe('tool_not_allowed');
  });

  it('王五（sales_manager）看业绩盘：放行且数字完整', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(adapter, WANG_WU, {
      tool: 'get_pipeline_summary',
      args: {},
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    const rows = result.data as { open_amount: number }[];
    expect(rows.map((r) => r.open_amount)).toEqual([1465000, 98000]);
  });

  it('HR 域角色进 CRM 域：hr_admin 是未知角色，通配权力不跨域', async () => {
    const guard = await loadGuard();
    const result = await guard.invoke(
      adapter,
      { userId: 'e004', role: 'hr_admin' },
      { tool: 'get_pipeline_summary', args: {} },
    );
    expect(result.kind).toBe('refusal');
    if (result.kind !== 'refusal') return;
    expect(result.reason).toBe('unknown_role');
  });
});
