import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonlApprovalStore, MemoryApprovalStore } from './approvals.js';
import { MemoryAuditLogger } from './audit.js';
import { Guard } from './guard.js';
import {
  evalApprovalCondition,
  loadRbacConfig,
  roleHasApprovalRule,
  roleRequiresApproval,
} from './rbac.js';
import type { Principal, SystemAdapter } from './types.js';

const rbac = loadRbacConfig(`
roles:
  sales_rep:
    tools: [list_contacts, delete_contact]
    approval: [delete_contact]
  sales_manager:
    tools: "*"
    approver: true
`);

const REP: Principal = { userId: 'e007', role: 'sales_rep' };

function makeCrm(): { adapter: SystemAdapter; executed: string[] } {
  const executed: string[] = [];
  const adapter: SystemAdapter = {
    system: 'fake-crm',
    tools: () => [
      { name: 'list_contacts', description: '列联系人', inputSchema: z.object({}) },
      {
        name: 'delete_contact',
        description: '删联系人',
        inputSchema: z.object({ id: z.string() }),
      },
    ],
    execute: async (call) => {
      executed.push(call.tool);
      return { data: { done: true, tool: call.tool } };
    },
  };
  return { adapter, executed };
}

describe('审批闸门', () => {
  it('涉审工具首次调用 → pending，未执行任何写入，审计记 PENDING，分支不含 data', async () => {
    const { adapter, executed } = makeCrm();
    const audit = new MemoryAuditLogger();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rbac, audit, { approvals: store });

    const result = await guard.invoke(adapter, REP, { tool: 'delete_contact', args: { id: 'c1' } });

    expect(result.kind).toBe('pending');
    expect(result).not.toHaveProperty('data');
    expect(executed).toHaveLength(0);
    expect(audit.events[0]?.decision).toBe('PENDING');
    expect(audit.events[0]?.reason).toBe('approval_required');
    expect(await store.listPending()).toHaveLength(1);
  });

  it('同参重复调用幂等：命中同一张单，不重复开单', async () => {
    const { adapter } = makeCrm();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rbac, new MemoryAuditLogger(), { approvals: store });
    const call = { tool: 'delete_contact', args: { id: 'c1' } };

    const first = await guard.invoke(adapter, REP, call);
    const second = await guard.invoke(adapter, REP, call);

    expect(first.kind).toBe('pending');
    expect(second.kind).toBe('pending');
    if (first.kind !== 'pending' || second.kind !== 'pending') return;
    expect(second.approvalId).toBe(first.approvalId);
    expect(await store.listPending()).toHaveLength(1);
  });

  it('参数不同 → 各开各的单', async () => {
    const { adapter } = makeCrm();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rbac, new MemoryAuditLogger(), { approvals: store });

    await guard.invoke(adapter, REP, { tool: 'delete_contact', args: { id: 'c1' } });
    await guard.invoke(adapter, REP, { tool: 'delete_contact', args: { id: 'c2' } });

    expect(await store.listPending()).toHaveLength(2);
  });

  it('批准后重试 → 执行一次并消票；再来一次是新的 pending', async () => {
    const { adapter, executed } = makeCrm();
    const audit = new MemoryAuditLogger();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rbac, audit, { approvals: store });
    const call = { tool: 'delete_contact', args: { id: 'c1' } };

    const pending = await guard.invoke(adapter, REP, call);
    if (pending.kind !== 'pending') throw new Error('应为 pending');
    await store.decide(pending.approvalId, 'approved', 'e005');

    const resumed = await guard.invoke(adapter, REP, call);
    expect(resumed.kind).toBe('ok');
    expect(executed).toEqual(['delete_contact']);
    expect(audit.events.at(-1)?.decision).toBe('ALLOW');

    // 票已消费，第三次调用回到 pending（新单，防重放）
    const replay = await guard.invoke(adapter, REP, call);
    expect(replay.kind).toBe('pending');
    if (replay.kind === 'pending') expect(replay.approvalId).not.toBe(pending.approvalId);
    expect(executed).toEqual(['delete_contact']);
  });

  it('被拒后重试 → approval_denied 拒答且不执行；拒票同样一次性', async () => {
    const { adapter, executed } = makeCrm();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rbac, new MemoryAuditLogger(), { approvals: store });
    const call = { tool: 'delete_contact', args: { id: 'c1' } };

    const pending = await guard.invoke(adapter, REP, call);
    if (pending.kind !== 'pending') throw new Error('应为 pending');
    await store.decide(pending.approvalId, 'denied', 'e005');

    const denied = await guard.invoke(adapter, REP, call);
    expect(denied.kind).toBe('refusal');
    if (denied.kind === 'refusal') expect(denied.reason).toBe('approval_denied');
    expect(executed).toHaveLength(0);

    const again = await guard.invoke(adapter, REP, call);
    expect(again.kind).toBe('pending');
  });

  it('配置了 approval 却没接存储 → error，fail-closed 不执行', async () => {
    const { adapter, executed } = makeCrm();
    const guard = new Guard(rbac, new MemoryAuditLogger());

    const result = await guard.invoke(adapter, REP, { tool: 'delete_contact', args: { id: 'c1' } });

    expect(result.kind).toBe('error');
    expect(executed).toHaveLength(0);
  });

  it('过期单视同不存在：新调用重新开单', async () => {
    const { adapter } = makeCrm();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rbac, new MemoryAuditLogger(), {
      approvals: store,
      approvalTtlMs: -1000, // 开出即过期
    });
    const call = { tool: 'delete_contact', args: { id: 'c1' } };

    const first = await guard.invoke(adapter, REP, call);
    const second = await guard.invoke(adapter, REP, call);

    expect(first.kind).toBe('pending');
    expect(second.kind).toBe('pending');
    if (first.kind !== 'pending' || second.kind !== 'pending') return;
    expect(second.approvalId).not.toBe(first.approvalId);
  });

  it('免审工具与免审角色不受闸门影响', async () => {
    const { adapter, executed } = makeCrm();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rbac, new MemoryAuditLogger(), { approvals: store });

    const listResult = await guard.invoke(adapter, REP, { tool: 'list_contacts', args: {} });
    const managerDelete = await guard.invoke(
      adapter,
      { userId: 'e005', role: 'sales_manager' },
      { tool: 'delete_contact', args: { id: 'c1' } },
    );

    expect(listResult.kind).toBe('ok');
    expect(managerDelete.kind).toBe('ok');
    expect(executed).toEqual(['list_contacts', 'delete_contact']);
    expect(await store.listPending()).toHaveLength(0);
  });

  it('JsonlApprovalStore：事件回放跨实例重建状态', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foundry-approvals-'));
    const filePath = join(dir, 'approvals.jsonl');

    const storeA = new JsonlApprovalStore(filePath);
    const created = await storeA.create({
      system: 'fake-crm',
      tool: 'delete_contact',
      args: { id: 'c1' },
      argsHash: 'abc',
      userId: 'e007',
      role: 'sales_rep',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await storeA.annotate(created.id, { chatId: 'oc_1' });
    await storeA.decide(created.id, 'approved', 'e005');

    // 新实例从同一文件回放
    const storeB = new JsonlApprovalStore(filePath);
    const replayed = await storeB.get(created.id);
    expect(replayed?.status).toBe('approved');
    expect(replayed?.approverId).toBe('e005');
    expect(replayed?.meta).toEqual({ chatId: 'oc_1' });

    await storeB.consume(created.id);
    const storeC = new JsonlApprovalStore(filePath);
    expect((await storeC.get(created.id))?.consumedAt).toBeDefined();
    expect(await storeC.find('fake-crm', 'e007', 'delete_contact', 'abc')).toBeNull();
  });

  it('参数键序不同的重试命中同一张已批准单（hashArgs 规范化）', async () => {
    const { adapter, executed } = makeCrm();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rbac, new MemoryAuditLogger(), { approvals: store });

    const first = await guard.invoke(adapter, REP, {
      tool: 'delete_contact',
      args: { id: 'c1', reason: 'dup' },
    });
    if (first.kind !== 'pending') throw new Error('应为 pending');
    await store.decide(first.approvalId, 'approved', 'e005');

    // 键序颠倒的同参重试（LLM 复述常见）——应消同一张单并执行，而不是另开新单
    const resumed = await guard.invoke(adapter, REP, {
      tool: 'delete_contact',
      args: { reason: 'dup', id: 'c1' },
    });
    expect(resumed.kind).toBe('ok');
    expect(executed).toEqual(['delete_contact']);
    expect(await store.listPending()).toHaveLength(0);
  });

  it('JsonlApprovalStore 容忍末尾半截记录（崩溃残留），不整体卡死', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foundry-approvals-torn-'));
    const filePath = join(dir, 'approvals.jsonl');

    const storeA = new JsonlApprovalStore(filePath);
    const rec = await storeA.create({
      system: 'fake-crm',
      tool: 'delete_contact',
      args: { id: 'c1' },
      argsHash: 'h1',
      userId: 'e007',
      role: 'sales_rep',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    // 追加一行半截 JSON（模拟 appendFile 中途被杀）
    await appendFile(filePath, '{"type":"decided","id":"', 'utf8');

    const storeB = new JsonlApprovalStore(filePath);
    // 完整的第一条仍能回放出来，半截末行被跳过而非抛错卡死
    expect((await storeB.get(rec.id))?.status).toBe('pending');
    expect(await storeB.listPending()).toHaveLength(1);
  });

  it('重复批复与重复消费被拒绝', async () => {
    const store = new MemoryApprovalStore();
    const record = await store.create({
      system: 's',
      tool: 't',
      args: {},
      argsHash: 'h',
      userId: 'u',
      role: 'r',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    await store.decide(record.id, 'approved', 'boss');
    await expect(store.decide(record.id, 'denied', 'boss')).rejects.toThrow('不能重复批复');
    await store.consume(record.id);
    await expect(store.consume(record.id)).rejects.toThrow('已被消费');
  });

  it('并发消费同一张已批准单只成功一次（防重放 TOCTOU）', async () => {
    const store = new MemoryApprovalStore();
    const record = await store.create({
      system: 's',
      tool: 't',
      args: {},
      argsHash: 'h',
      userId: 'u',
      role: 'r',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    await store.decide(record.id, 'approved', 'boss');

    // 同时发起两次消费：检查与置位间没有 await，只有一次能过 consumedAt 检查；
    // 修复前两次都会在各自 await persist 前读到 consumedAt===undefined 而双双放行（重放打款）。
    const results = await Promise.allSettled([store.consume(record.id), store.consume(record.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    expect(rejected).toHaveLength(1);
    expect(String(rejected[0]?.reason)).toContain('已被消费');
  });

  it('并发批复同一张单只成功一次', async () => {
    const store = new MemoryApprovalStore();
    const record = await store.create({
      system: 's',
      tool: 't',
      args: {},
      argsHash: 'h',
      userId: 'u',
      role: 'r',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });

    const results = await Promise.allSettled([
      store.decide(record.id, 'approved', 'boss'),
      store.decide(record.id, 'denied', 'boss'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
  });
});

// ── 分级审批（条件式 policy-as-code）───────────────────────────────────────
const gradedRbac = loadRbacConfig(`
roles:
  sales_rep:
    tools: [issue_refund]
    approval:
      - tool: issue_refund
        when:
          anyOf:
            - { field: amount, gt: 500 }
            - { field: refundCountThisMonth, gte: 2 }
  sales_manager:
    tools: "*"
    approver: true
`);

/** 带 approvalSignals 的退款适配器；priorCount 模拟「本月已退笔数」信号。 */
function makeRefundCrm(priorCount = 0): { adapter: SystemAdapter; executed: unknown[] } {
  const executed: unknown[] = [];
  const adapter: SystemAdapter = {
    system: 'fake-crm',
    tools: () => [{ name: 'issue_refund', description: '退款', inputSchema: z.object({}) }],
    execute: async (call) => {
      executed.push(call.args);
      return { data: { status: 'issued', ...call.args } };
    },
    approvalSignals: async () => ({ refundCountThisMonth: priorCount }),
  };
  return { adapter, executed };
}

describe('条件求值 evalApprovalCondition', () => {
  it('数值比较 gt/gte/lt/lte', () => {
    expect(evalApprovalCondition({ field: 'amount', gt: 500 }, { amount: 600 })).toBe(true);
    expect(evalApprovalCondition({ field: 'amount', gt: 500 }, { amount: 500 })).toBe(false);
    expect(evalApprovalCondition({ field: 'n', gte: 2 }, { n: 2 })).toBe(true);
    expect(evalApprovalCondition({ field: 'n', lt: 2 }, { n: 1 })).toBe(true);
    expect(evalApprovalCondition({ field: 'n', lte: 2 }, { n: 3 })).toBe(false);
  });

  it('anyOf / allOf 组合', () => {
    const cond = {
      anyOf: [{ field: 'amount', gt: 500 } as const, { field: 'c', gte: 2 } as const],
    };
    expect(evalApprovalCondition(cond, { amount: 100, c: 2 })).toBe(true); // 频次命中
    expect(evalApprovalCondition(cond, { amount: 800, c: 0 })).toBe(true); // 金额命中
    expect(evalApprovalCondition(cond, { amount: 100, c: 0 })).toBe(false); // 都不命中
    const all = { allOf: [{ field: 'a', gt: 1 } as const, { field: 'b', gt: 1 } as const] };
    expect(evalApprovalCondition(all, { a: 2, b: 2 })).toBe(true);
    expect(evalApprovalCondition(all, { a: 2, b: 0 })).toBe(false);
  });

  it('缺失/非数值字段 → true（fail-safe，不静默放行）', () => {
    expect(evalApprovalCondition({ field: 'amount', gt: 500 }, {})).toBe(true);
    expect(evalApprovalCondition({ field: 'amount', gt: 500 }, { amount: 'oops' })).toBe(true);
  });
});

describe('roleRequiresApproval / roleHasApprovalRule', () => {
  const role = gradedRbac.roles.sales_rep;
  it('纯工具名条目一律涉审；无条目的工具不涉审', () => {
    const plain = loadRbacConfig(`
roles:
  r:
    tools: [x, y]
    approval: [x]
`).roles.r;
    if (!plain) throw new Error('role r 缺失');
    expect(roleRequiresApproval(plain, 'x', {})).toBe(true);
    expect(roleRequiresApproval(plain, 'y', {})).toBe(false);
  });
  it('条件条目按 ctx 求值', () => {
    if (!role) throw new Error('sales_rep 缺失');
    expect(roleHasApprovalRule(role, 'issue_refund')).toBe(true);
    expect(
      roleRequiresApproval(role, 'issue_refund', { amount: 200, refundCountThisMonth: 0 }),
    ).toBe(false);
    expect(
      roleRequiresApproval(role, 'issue_refund', { amount: 8000, refundCountThisMonth: 0 }),
    ).toBe(true);
    expect(
      roleRequiresApproval(role, 'issue_refund', { amount: 100, refundCountThisMonth: 2 }),
    ).toBe(true);
  });
});

describe('分级审批闸门（守卫端到端）', () => {
  it('小额退款 → 自动放行执行（金额与频次都未触发）', async () => {
    const { adapter, executed } = makeRefundCrm(0);
    const guard = new Guard(gradedRbac, new MemoryAuditLogger(), {
      approvals: new MemoryApprovalStore(),
    });
    const result = await guard.invoke(adapter, REP, {
      tool: 'issue_refund',
      args: { amount: 200 },
    });
    expect(result.kind).toBe('ok');
    expect(executed).toHaveLength(1);
  });

  it('大额退款 → 触发审批 pending，未执行', async () => {
    const { adapter, executed } = makeRefundCrm(0);
    const store = new MemoryApprovalStore();
    const guard = new Guard(gradedRbac, new MemoryAuditLogger(), { approvals: store });
    const result = await guard.invoke(adapter, REP, {
      tool: 'issue_refund',
      args: { amount: 8000 },
    });
    expect(result.kind).toBe('pending');
    expect(executed).toHaveLength(0);
    expect(await store.listPending()).toHaveLength(1);
  });

  it('小额但本月已退 ≥2 笔（信号来自 approvalSignals）→ 频次触发审批', async () => {
    const { adapter, executed } = makeRefundCrm(2);
    const guard = new Guard(gradedRbac, new MemoryAuditLogger(), {
      approvals: new MemoryApprovalStore(),
    });
    const result = await guard.invoke(adapter, REP, {
      tool: 'issue_refund',
      args: { amount: 100 },
    });
    expect(result.kind).toBe('pending');
    expect(executed).toHaveLength(0);
  });

  it('缺 amount 字段 → fail-safe 触发审批，绝不静默放行', async () => {
    const { adapter, executed } = makeRefundCrm(0);
    const guard = new Guard(gradedRbac, new MemoryAuditLogger(), {
      approvals: new MemoryApprovalStore(),
    });
    const result = await guard.invoke(adapter, REP, { tool: 'issue_refund', args: {} });
    expect(result.kind).toBe('pending');
    expect(executed).toHaveLength(0);
  });

  it('免审角色（经理，approval 空）大额退款也直通', async () => {
    const { adapter, executed } = makeRefundCrm(0);
    const guard = new Guard(gradedRbac, new MemoryAuditLogger(), {
      approvals: new MemoryApprovalStore(),
    });
    const result = await guard.invoke(
      adapter,
      { userId: 'e005', role: 'sales_manager' },
      { tool: 'issue_refund', args: { amount: 8000 } },
    );
    expect(result.kind).toBe('ok');
    expect(executed).toHaveLength(1);
  });
});

// ── 行级受限写工具：目标不存在与「非本人」不可区分，且都不开审批单 ─────────────────
// 修复前：preimage 返回 null（目标不存在）时守卫跳过归属校验、径直进审批闸门开单，于是
// 「不存在 → pending」与「越权 → row_denied」出现可区分差异——成了越权枚举记录存在性的预言机，
// 且每个伪造 id 都会凭空生成一张审批单（灌爆 approvals.jsonl 与审批人队列）。
const rowScopedRbac = loadRbacConfig(`
roles:
  sales_rep:
    tools: [delete_contact]
    approval: [delete_contact]
    rows:
      - field: owner_id
        equals: $self.userId
  sales_manager:
    tools: "*"
    approver: true
`);

/** preimage 适配器：'own' 属 e007、'other' 属别人、其余（如伪造 id）→ null（不存在）。 */
function makeRowScopedCrm(): { adapter: SystemAdapter; executed: string[] } {
  const executed: string[] = [];
  const rows: Record<string, { id: string; owner_id: string } | undefined> = {
    own: { id: 'own', owner_id: 'e007' },
    other: { id: 'other', owner_id: 'e999' },
  };
  const adapter: SystemAdapter = {
    system: 'fake-crm',
    tools: () => [
      {
        name: 'delete_contact',
        description: '删联系人',
        inputSchema: z.object({ id: z.string() }),
      },
    ],
    execute: async (call) => {
      executed.push(call.tool);
      return { data: { done: true } };
    },
    preimage: async (call) => {
      const id = typeof call.args.id === 'string' ? call.args.id : undefined;
      return id === undefined ? undefined : (rows[id] ?? null);
    },
  };
  return { adapter, executed };
}

describe('行级受限写工具：不存在与越权不可区分，均不开单', () => {
  it('目标不存在 → row_denied，不开审批单、不执行', async () => {
    const { adapter, executed } = makeRowScopedCrm();
    const audit = new MemoryAuditLogger();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rowScopedRbac, audit, { approvals: store });

    const result = await guard.invoke(adapter, REP, {
      tool: 'delete_contact',
      args: { id: 'ghost' },
    });

    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') expect(result.reason).toBe('row_denied');
    expect(result).not.toHaveProperty('data');
    expect(executed).toHaveLength(0);
    // 关键：伪造 id 不再凭空开单（DoS/灌爆审批队列面被关闭）
    expect(await store.listPending()).toHaveLength(0);
    expect(audit.events.at(-1)?.decision).toBe('DENY');
  });

  it('目标存在但非本人 → row_denied，不开单、不执行', async () => {
    const { adapter, executed } = makeRowScopedCrm();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rowScopedRbac, new MemoryAuditLogger(), { approvals: store });

    const result = await guard.invoke(adapter, REP, {
      tool: 'delete_contact',
      args: { id: 'other' },
    });

    expect(result.kind).toBe('refusal');
    if (result.kind === 'refusal') expect(result.reason).toBe('row_denied');
    expect(executed).toHaveLength(0);
    expect(await store.listPending()).toHaveLength(0);
  });

  it('「不存在」与「非本人」对调用方完全不可区分（同 kind/reason/rule）—— 关闭存在性预言机', async () => {
    const guard = new Guard(rowScopedRbac, new MemoryAuditLogger(), {
      approvals: new MemoryApprovalStore(),
    });
    const ghost = await guard.invoke(makeRowScopedCrm().adapter, REP, {
      tool: 'delete_contact',
      args: { id: 'ghost' },
    });
    const notMine = await guard.invoke(makeRowScopedCrm().adapter, REP, {
      tool: 'delete_contact',
      args: { id: 'other' },
    });
    expect(ghost).toEqual(notMine);
  });

  it('自己名下的行仍照常开审批单（护栏未误伤正常路径）', async () => {
    const { adapter, executed } = makeRowScopedCrm();
    const store = new MemoryApprovalStore();
    const guard = new Guard(rowScopedRbac, new MemoryAuditLogger(), { approvals: store });

    const result = await guard.invoke(adapter, REP, {
      tool: 'delete_contact',
      args: { id: 'own' },
    });

    expect(result.kind).toBe('pending');
    expect(executed).toHaveLength(0);
    expect(await store.listPending()).toHaveLength(1);
  });
});
