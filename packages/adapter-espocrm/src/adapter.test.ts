import { readFile } from 'node:fs/promises';
import type { Principal } from '@yiong/foundry-core';
import { Guard, loadRbacConfig, MemoryApprovalStore, MemoryAuditLogger } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { createEspoCrmAdapter } from './adapter.js';

// env: {} 保证测试不受本机 ESPOCRM_* 环境变量影响，始终走 fixture
const adapter = createEspoCrmAdapter({ env: {} });
// 直调 execute 需要身份占位——espocrm 适配器不读它（权限在守卫层），传谁都一样
const CALLER: Principal = { userId: 'e000', role: 'test' };

describe('fixture 模式：七读四写', () => {
  it('tools() 恰好 11 个，名称与顺序稳定', () => {
    expect(adapter.system).toBe('espocrm');
    expect(adapter.tools().map((t) => t.name)).toEqual([
      'list_accounts',
      'get_account',
      'list_contacts',
      'get_contact',
      'list_opportunities',
      'get_opportunity',
      'get_pipeline_summary',
      'create_contact',
      'update_contact',
      'delete_contact',
      'update_opportunity_stage',
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
    await expect(adapter.execute({ tool: 'drop_database', args: {} }, CALLER)).rejects.toThrow();
  });
});

describe('fixture 模式：写工具', () => {
  it('create_contact：归属戳取自 principal，写入后可查回；模块级 fixture 常量不被污染', async () => {
    const isolated = createEspoCrmAdapter({ env: {} });
    const { data } = await isolated.execute(
      { tool: 'create_contact', args: { name: '赵新客', title: '总经理', account_id: 'a001' } },
      { userId: 'e007', role: 'sales_rep' },
    );
    const created = data as { contact_id: string; owner_id: string; name: string };
    expect(created.owner_id).toBe('e007');
    expect(created.name).toBe('赵新客');

    const { data: fetched } = await isolated.execute(
      { tool: 'get_contact', args: { contact_id: created.contact_id } },
      CALLER,
    );
    expect((fetched as { name: string }).name).toBe('赵新客');

    // 另一个实例看不到写入——实例态隔离，评测题面引用的数值安全
    const fresh = createEspoCrmAdapter({ env: {} });
    const { data: others } = await fresh.execute({ tool: 'list_contacts', args: {} }, CALLER);
    expect(others).toHaveLength(5);
  });

  it('update_contact：改 title 生效，未提字段不动；不存在返回 null', async () => {
    const isolated = createEspoCrmAdapter({ env: {} });
    const { data } = await isolated.execute(
      { tool: 'update_contact', args: { contact_id: 'c001', title: '副总裁' } },
      CALLER,
    );
    const updated = data as { title: string; email: string };
    expect(updated.title).toBe('副总裁');
    expect(updated.email).toBe('chenjianguo@huasheng.example.com');

    const { data: miss } = await isolated.execute(
      { tool: 'update_contact', args: { contact_id: 'c999', title: 'x' } },
      CALLER,
    );
    expect(miss).toBeNull();
  });

  it('update_contact：一个可改字段都不给 → 参数校验抛错', async () => {
    await expect(
      adapter.execute({ tool: 'update_contact', args: { contact_id: 'c001' } }, CALLER),
    ).rejects.toThrow();
  });

  it('delete_contact：返回被删行，随后查不到', async () => {
    const isolated = createEspoCrmAdapter({ env: {} });
    const { data } = await isolated.execute(
      { tool: 'delete_contact', args: { contact_id: 'c002' } },
      CALLER,
    );
    expect((data as { contact_id: string }).contact_id).toBe('c002');

    const { data: gone } = await isolated.execute(
      { tool: 'get_contact', args: { contact_id: 'c002' } },
      CALLER,
    );
    expect(gone).toBeNull();
  });

  it('update_opportunity_stage：合法枚举生效并反映进业绩汇总；非法枚举抛错', async () => {
    const isolated = createEspoCrmAdapter({ env: {} });
    const { data } = await isolated.execute(
      { tool: 'update_opportunity_stage', args: { opportunity_id: 'o001', stage: 'Closed Won' } },
      CALLER,
    );
    expect((data as { stage: string }).stage).toBe('Closed Won');

    const { data: summary } = await isolated.execute(
      { tool: 'get_pipeline_summary', args: {} },
      CALLER,
    );
    const sunQi = (summary as { owner_id: string; won_count: number }[]).find(
      (r) => r.owner_id === 'e007',
    );
    expect(sunQi?.won_count).toBe(1);

    await expect(
      isolated.execute(
        { tool: 'update_opportunity_stage', args: { opportunity_id: 'o001', stage: '随便写' } },
        CALLER,
      ),
    ).rejects.toThrow();
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

  it('审批闸门联动：孙七删联系人 → pending；批准后重试 → 真删且 phone 照常脱敏', async () => {
    const isolated = createEspoCrmAdapter({ env: {} });
    const store = new MemoryApprovalStore();
    const yamlText = await readFile(
      new URL('../../../config/rbac.espocrm.yaml', import.meta.url),
      'utf8',
    );
    const guard = new Guard(loadRbacConfig(yamlText), new MemoryAuditLogger(), {
      approvals: store,
    });
    const call = { tool: 'delete_contact', args: { contact_id: 'c001' } };

    const pending = await guard.invoke(isolated, SUN_QI, call);
    expect(pending.kind).toBe('pending');
    if (pending.kind !== 'pending') return;

    // 未批复前联系人还在
    const stillThere = await guard.invoke(isolated, SUN_QI, {
      tool: 'get_contact',
      args: { contact_id: 'c001' },
    });
    expect(stillThere.kind).toBe('ok');

    await store.decide(pending.approvalId, 'approved', 'e005');
    const resumed = await guard.invoke(isolated, SUN_QI, call);
    expect(resumed.kind).toBe('ok');
    if (resumed.kind !== 'ok') return;
    expect(resumed.data).toHaveProperty('contact_id', 'c001');
    expect(resumed.data).not.toHaveProperty('phone');

    // 删除后直查适配器确认行已不在（守卫路径上 null 会被行级规则「宁可错拒」成 row_denied，
    // 那是读路径的既定行为，不在本用例断言范围）
    const { data: gone } = await isolated.execute(
      { tool: 'get_contact', args: { contact_id: 'c001' } },
      SUN_QI,
    );
    expect(gone).toBeNull();
  });

  it('审批闸门联动：王五（sales_manager，免审）直接删除成功', async () => {
    const isolated = createEspoCrmAdapter({ env: {} });
    const yamlText = await readFile(
      new URL('../../../config/rbac.espocrm.yaml', import.meta.url),
      'utf8',
    );
    const guard = new Guard(loadRbacConfig(yamlText), new MemoryAuditLogger(), {
      approvals: new MemoryApprovalStore(),
    });

    const result = await guard.invoke(isolated, WANG_WU, {
      tool: 'delete_contact',
      args: { contact_id: 'c003' },
    });
    expect(result.kind).toBe('ok');
  });

  it('写工具行级归属前置校验：孙七删同事(e008)的联系人 → execute 前就 row_denied，未删、未开审批单', async () => {
    const isolated = createEspoCrmAdapter({ env: {} });
    const store = new MemoryApprovalStore();
    const yamlText = await readFile(
      new URL('../../../config/rbac.espocrm.yaml', import.meta.url),
      'utf8',
    );
    const guard = new Guard(loadRbacConfig(yamlText), new MemoryAuditLogger(), {
      approvals: store,
    });

    // c003 归属 e008，孙七(e007)无权动它
    const result = await guard.invoke(isolated, SUN_QI, {
      tool: 'delete_contact',
      args: { contact_id: 'c003' },
    });

    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') expect(result.reason).toBe('row_denied');
    // 关键：没有因为「先执行后判权」把 c003 删掉——用经理身份查证它还在
    const stillThere = await isolated.execute(
      { tool: 'get_contact', args: { contact_id: 'c003' } },
      WANG_WU,
    );
    expect((stillThere.data as { contact_id: string }).contact_id).toBe('c003');
    // 也没有为一个越权操作开出审批单
    expect(await store.listPending()).toHaveLength(0);
  });

  it('写工具行级归属前置校验：孙七改同事商机阶段 → row_denied，未改动', async () => {
    const isolated = createEspoCrmAdapter({ env: {} });
    const yamlText = await readFile(
      new URL('../../../config/rbac.espocrm.yaml', import.meta.url),
      'utf8',
    );
    const guard = new Guard(loadRbacConfig(yamlText), new MemoryAuditLogger(), {
      approvals: new MemoryApprovalStore(),
    });

    // o003 归属 e008
    const result = await guard.invoke(isolated, SUN_QI, {
      tool: 'update_opportunity_stage',
      args: { opportunity_id: 'o003', stage: 'Closed Lost' },
    });

    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') expect(result.reason).toBe('row_denied');
    const unchanged = await isolated.execute(
      { tool: 'get_opportunity', args: { opportunity_id: 'o003' } },
      WANG_WU,
    );
    expect((unchanged.data as { stage: string }).stage).toBe('Closed Won');
  });

  it('审批闸门联动：孙七 create_contact 免审直通，归属自动是自己', async () => {
    const isolated = createEspoCrmAdapter({ env: {} });
    const yamlText = await readFile(
      new URL('../../../config/rbac.espocrm.yaml', import.meta.url),
      'utf8',
    );
    const guard = new Guard(loadRbacConfig(yamlText), new MemoryAuditLogger(), {
      approvals: new MemoryApprovalStore(),
    });

    const result = await guard.invoke(isolated, SUN_QI, {
      tool: 'create_contact',
      args: { name: '新联系人' },
    });
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect((result.data as { owner_id: string }).owner_id).toBe('e007');
  });
});
