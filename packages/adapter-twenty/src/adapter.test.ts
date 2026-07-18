import { readFile } from 'node:fs/promises';
import type { Principal } from '@yiong/foundry-core';
import { Guard, loadRbacConfig, MemoryApprovalStore, MemoryAuditLogger } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { createTwentyAdapter } from './adapter.js';

const adapter = createTwentyAdapter({ env: {} });
const CALLER: Principal = { userId: 'e000', role: 'test' };

describe('twenty fixture：七读五写', () => {
  it('tools() 恰好 12 个，名称与顺序稳定', () => {
    expect(adapter.system).toBe('twenty');
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
      'issue_refund',
    ]);
  });

  it('list_contacts 列表行不夹带 email/phone；get_contact 才带', async () => {
    const { data: all } = await adapter.execute({ tool: 'list_contacts', args: {} }, CALLER);
    expect(all).toHaveLength(5);
    expect((all as Record<string, unknown>[])[0]).toEqual({
      contact_id: 'c001',
      name: '陈建国',
      title: '采购总监',
      account_id: 'a001',
      owner_id: 'e007',
    });
    const { data: one } = await adapter.execute(
      { tool: 'get_contact', args: { contact_id: 'c001' } },
      CALLER,
    );
    expect(one).toHaveProperty('email');
    expect(one).toHaveProperty('phone');
  });

  it('get_pipeline_summary：按 owner 聚合 open 商机金额与数量', async () => {
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

  it('写工具：create 盖归属、update 改字段、delete 返回被删行、改阶段反映进汇总', async () => {
    const a = createTwentyAdapter({ env: {} });
    const { data: created } = await a.execute(
      { tool: 'create_contact', args: { name: '新客' } },
      { userId: 'e007', role: 'sales_rep' },
    );
    expect((created as { owner_id: string }).owner_id).toBe('e007');

    const { data: updated } = await a.execute(
      { tool: 'update_contact', args: { contact_id: 'c001', title: '副总裁' } },
      CALLER,
    );
    expect((updated as { title: string }).title).toBe('副总裁');

    const { data: deleted } = await a.execute(
      { tool: 'delete_contact', args: { contact_id: 'c002' } },
      CALLER,
    );
    expect((deleted as { contact_id: string }).contact_id).toBe('c002');

    await a.execute(
      { tool: 'update_opportunity_stage', args: { opportunity_id: 'o001', stage: 'Closed Won' } },
      CALLER,
    );
    const { data: summary } = await a.execute({ tool: 'get_pipeline_summary', args: {} }, CALLER);
    expect(
      (summary as { owner_id: string; won_count: number }[]).find((r) => r.owner_id === 'e007')
        ?.won_count,
    ).toBe(1);
  });

  it('update_contact 一个字段都不给 → 抛错；未知工具 → 抛错', async () => {
    await expect(
      adapter.execute({ tool: 'update_contact', args: { contact_id: 'c001' } }, CALLER),
    ).rejects.toThrow();
    await expect(adapter.execute({ tool: 'drop_all', args: {} }, CALLER)).rejects.toThrow();
  });
});

// 关键验证：同一套 rbac.twenty.yaml + 同一套守卫，行级过滤/字段脱敏在 twenty 后端上如常生效
describe('rbac.twenty.yaml 与守卫联动（守卫与后端无关）', () => {
  const SUN_QI: Principal = { userId: 'e007', role: 'sales_rep' };
  const WANG_WU: Principal = { userId: 'e005', role: 'sales_manager' };

  async function loadGuard(store = new MemoryApprovalStore()): Promise<Guard> {
    const yamlText = await readFile(
      new URL('../../../config/rbac.twenty.yaml', import.meta.url),
      'utf8',
    );
    return new Guard(loadRbacConfig(yamlText), new MemoryAuditLogger(), { approvals: store });
  }

  it('孙七拉客户：只见自己的 3 家', async () => {
    const guard = await loadGuard();
    const r = await guard.invoke(adapter, SUN_QI, { tool: 'list_accounts', args: {} });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect((r.data as { account_id: string }[]).map((x) => x.account_id)).toEqual([
        'a001',
        'a002',
        'a005',
      ]);
    }
  });

  it('孙七查自己客户的联系人：放行但 phone 脱敏', async () => {
    const guard = await loadGuard();
    const r = await guard.invoke(adapter, SUN_QI, {
      tool: 'get_contact',
      args: { contact_id: 'c001' },
    });
    expect(r.kind).toBe('ok');
    if (r.kind === 'ok') {
      expect(r.data).toHaveProperty('email');
      expect(r.data).not.toHaveProperty('phone');
    }
  });

  it('孙七清点全员业绩盘：工具白名单拒绝', async () => {
    const guard = await loadGuard();
    const r = await guard.invoke(adapter, SUN_QI, { tool: 'get_pipeline_summary', args: {} });
    expect(r.kind).toBe('refusal');
    if (r.kind === 'refusal') expect(r.reason).toBe('tool_not_allowed');
  });

  it('审批闸门：孙七删自己的 c001 → pending；批准后重试执行且 phone 脱敏', async () => {
    const a = createTwentyAdapter({ env: {} });
    const store = new MemoryApprovalStore();
    const guard = await loadGuard(store);
    const call = { tool: 'delete_contact', args: { contact_id: 'c001' } };
    const pending = await guard.invoke(a, SUN_QI, call);
    expect(pending.kind).toBe('pending');
    if (pending.kind !== 'pending') return;
    await store.decide(pending.approvalId, 'approved', 'e005');
    const done = await guard.invoke(a, SUN_QI, call);
    expect(done.kind).toBe('ok');
    if (done.kind === 'ok') {
      expect(done.data).toHaveProperty('contact_id', 'c001');
      expect(done.data).not.toHaveProperty('phone');
    }
  });

  it('写前归属校验：孙七删同事(e008)的 c003 → execute 前 row_denied，未删', async () => {
    const a = createTwentyAdapter({ env: {} });
    const guard = await loadGuard();
    const r = await guard.invoke(a, SUN_QI, {
      tool: 'delete_contact',
      args: { contact_id: 'c003' },
    });
    expect(r.kind).toBe('refusal');
    if (r.kind === 'refusal') expect(r.reason).toBe('row_denied');
    const still = await a.execute({ tool: 'get_contact', args: { contact_id: 'c003' } }, WANG_WU);
    expect((still.data as { contact_id: string }).contact_id).toBe('c003');
  });

  const REFUND_OK = {
    order_id: 'ord-1001',
    email: 'chenjianguo@huasheng.example.com',
    last_four: '4321',
  };

  it('退款身份核验通过 → 落账，归属随订单（e007）不取参数', async () => {
    const a = createTwentyAdapter({ env: {} });
    const { data } = await a.execute(
      { tool: 'issue_refund', args: { ...REFUND_OK, amount: 200 } },
      SUN_QI,
    );
    expect(data).toMatchObject({
      status: 'issued',
      order_id: 'ord-1001',
      amount: 200,
      owner_id: 'e007',
    });
  });

  it('退款身份核验不过（卡尾号错）→ 抛错不落账', async () => {
    const a = createTwentyAdapter({ env: {} });
    await expect(
      a.execute(
        { tool: 'issue_refund', args: { ...REFUND_OK, last_four: '0000', amount: 200 } },
        SUN_QI,
      ),
    ).rejects.toThrow('身份核验');
  });

  it('退款金额超过订单已付 → 抛错', async () => {
    const a = createTwentyAdapter({ env: {} });
    await expect(
      a.execute({ tool: 'issue_refund', args: { ...REFUND_OK, amount: 999_999_999 } }, SUN_QI),
    ).rejects.toThrow('超过订单已付');
  });

  it('approvalSignals 报本月已退笔数；preimage 取订单（含归属）供守卫核验', async () => {
    const a = createTwentyAdapter({ env: {} });
    const call = { tool: 'issue_refund', args: { ...REFUND_OK, amount: 100 } };
    expect(await a.approvalSignals?.(call, SUN_QI)).toEqual({ refundCountThisMonth: 0 });
    await a.execute(call, SUN_QI);
    expect(await a.approvalSignals?.(call, SUN_QI)).toEqual({ refundCountThisMonth: 1 });
    expect(
      await a.preimage?.({ tool: 'issue_refund', args: { order_id: 'ord-2001' } }),
    ).toMatchObject({ order_id: 'ord-2001', owner_id: 'e008' });
  });

  it('守卫分级：孙七小额退款自动放行、大额挂起', async () => {
    const a = createTwentyAdapter({ env: {} });
    const guard = await loadGuard();
    const small = await guard.invoke(a, SUN_QI, {
      tool: 'issue_refund',
      args: { ...REFUND_OK, amount: 200 },
    });
    expect(small.kind).toBe('ok');
    const big = await guard.invoke(a, SUN_QI, {
      tool: 'issue_refund',
      args: { ...REFUND_OK, amount: 8000 },
    });
    expect(big.kind).toBe('pending');
  });

  it('守卫：孙七退同事名下订单 ord-2001 → 审批/核验前就 row_denied', async () => {
    const a = createTwentyAdapter({ env: {} });
    const guard = await loadGuard();
    const r = await guard.invoke(a, SUN_QI, {
      tool: 'issue_refund',
      args: {
        order_id: 'ord-2001',
        email: 'zhoutao@qiming.example.com',
        last_four: '1111',
        amount: 100,
      },
    });
    expect(r.kind).toBe('refusal');
    if (r.kind === 'refusal') expect(r.reason).toBe('row_denied');
  });
});
