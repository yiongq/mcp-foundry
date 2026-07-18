import { appendFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { JsonlApprovalStore, MemoryApprovalStore } from './approvals.js';
import { MemoryAuditLogger } from './audit.js';
import { Guard } from './guard.js';
import { loadRbacConfig } from './rbac.js';
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
});
