import type { ApprovalRecord, GuardedResult } from '@yiong/foundry-core';
import { loadRbacConfig, MemoryApprovalStore } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import type { ApprovalCardDeps } from './approval.js';
import { buildApprovalCard, handleCardAction, summarizeResult } from './approval.js';

const rbacCrm = loadRbacConfig(`
roles:
  sales_rep:
    tools: [delete_contact]
    approval: [delete_contact]
  sales_manager:
    tools: "*"
    approver: true
`);

const IDENTITIES = {
  ou_manager: { userId: 'e005', role: 'sales_manager' },
  ou_rep: { userId: 'e007', role: 'sales_rep' },
};

async function seedRecord(store: MemoryApprovalStore): Promise<ApprovalRecord> {
  const record = await store.create({
    system: 'twenty',
    tool: 'delete_contact',
    args: { contact_id: 'c001' },
    argsHash: 'hash1',
    userId: 'e007',
    role: 'sales_rep',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  return store.annotate(record.id, { chatId: 'oc_origin' });
}

interface Harness {
  deps: ApprovalCardDeps;
  store: MemoryApprovalStore;
  invoked: Array<{ principal: { userId: string; role: string }; tool: string }>;
  updatedCards: Array<{ messageId: string; card: Record<string, unknown> }>;
  sent: Array<{ chatId: string; markdown: string }>;
}

function makeHarness(
  invokeResult: GuardedResult = { kind: 'ok', data: { done: true }, maskedFields: [] },
): Harness {
  const store = new MemoryApprovalStore();
  const invoked: Harness['invoked'] = [];
  const updatedCards: Harness['updatedCards'] = [];
  const sent: Harness['sent'] = [];
  const deps: ApprovalCardDeps = {
    store,
    rbacBySystem: new Map([['twenty', rbacCrm]]),
    toolset: {
      invoke: async (principal, tool) => {
        invoked.push({ principal: { userId: principal.userId, role: principal.role }, tool });
        return invokeResult;
      },
    },
    identityMap: async () => IDENTITIES,
    updateCard: async (messageId, card) => {
      updatedCards.push({ messageId, card });
    },
    send: async (chatId, content) => {
      sent.push({ chatId, markdown: content.markdown });
    },
  };
  return { deps, store, invoked, updatedCards, sent };
}

function click(approvalId: string, decision: string, openId: string) {
  return {
    messageId: 'om_card',
    chatId: 'oc_approval',
    operator: { openId },
    action: { value: { approvalId, decision } },
  };
}

describe('审批卡片', () => {
  it('待批卡带同意/拒绝按钮，value 携带单号', async () => {
    const store = new MemoryApprovalStore();
    const record = await seedRecord(store);
    const card = buildApprovalCard(record);
    const actions = (
      card.elements as Array<{ tag: string; actions?: Array<{ value: unknown }> }>
    ).find((e) => e.tag === 'action')?.actions;
    expect(actions).toHaveLength(2);
    expect(actions?.[0]?.value).toEqual({ approvalId: record.id, decision: 'approve' });
    expect(actions?.[1]?.value).toEqual({ approvalId: record.id, decision: 'deny' });
  });

  it('经理点同意：批复落库 → 卡片翻绿 → 以发起人身份续跑 → 原会话收到 ✅', async () => {
    const h = makeHarness();
    const record = await seedRecord(h.store);

    await handleCardAction(h.deps, click(record.id, 'approve', 'ou_manager'));

    expect((await h.store.get(record.id))?.status).toBe('approved');
    expect(h.updatedCards).toHaveLength(1);
    expect(JSON.stringify(h.updatedCards[0]?.card)).toContain('已批准');
    // 续跑身份是发起人（sales_rep），不是审批人——审批不是权限旁路
    expect(h.invoked).toEqual([
      { principal: { userId: 'e007', role: 'sales_rep' }, tool: 'delete_contact' },
    ]);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.chatId).toBe('oc_origin');
    expect(h.sent[0]?.markdown).toContain('✅');
    expect(h.sent[0]?.markdown).toContain('已执行完成');
  });

  it('经理点拒绝：卡片翻红、不执行、原会话收到 ❌', async () => {
    const h = makeHarness();
    const record = await seedRecord(h.store);

    await handleCardAction(h.deps, click(record.id, 'deny', 'ou_manager'));

    expect((await h.store.get(record.id))?.status).toBe('denied');
    expect(h.invoked).toHaveLength(0);
    expect(JSON.stringify(h.updatedCards[0]?.card)).toContain('已拒绝');
    expect(h.sent[0]?.chatId).toBe('oc_origin');
    expect(h.sent[0]?.markdown).toContain('❌');
  });

  it('非审批人（sales_rep）点按钮：拒绝批复，单据保持 pending', async () => {
    const h = makeHarness();
    const record = await seedRecord(h.store);

    await handleCardAction(h.deps, click(record.id, 'approve', 'ou_rep'));

    expect((await h.store.get(record.id))?.status).toBe('pending');
    expect(h.invoked).toHaveLength(0);
    expect(h.sent[0]?.chatId).toBe('oc_approval');
    expect(h.sent[0]?.markdown).toContain('不是 twenty 域的审批人');
  });

  it('未绑定身份点按钮：提示绑定，不动单据', async () => {
    const h = makeHarness();
    const record = await seedRecord(h.store);

    await handleCardAction(h.deps, click(record.id, 'approve', 'ou_stranger'));

    expect((await h.store.get(record.id))?.status).toBe('pending');
    expect(h.sent[0]?.markdown).toContain('身份未绑定');
  });

  it('重复点按（已决单）：幂等翻面展示现状，不二次批复不二次执行', async () => {
    const h = makeHarness();
    const record = await seedRecord(h.store);
    await handleCardAction(h.deps, click(record.id, 'approve', 'ou_manager'));
    const invokedOnce = h.invoked.length;

    await handleCardAction(h.deps, click(record.id, 'deny', 'ou_manager'));

    expect((await h.store.get(record.id))?.status).toBe('approved');
    expect(h.invoked).toHaveLength(invokedOnce);
    expect(h.updatedCards).toHaveLength(2);
  });

  it('单据不存在：卡片翻灰说明；非审批卡的 value 被忽略', async () => {
    const h = makeHarness();
    await handleCardAction(h.deps, click('missing-id', 'approve', 'ou_manager'));
    expect(JSON.stringify(h.updatedCards[0]?.card)).toContain('不存在');

    await handleCardAction(h.deps, {
      messageId: 'om_other',
      chatId: 'oc_x',
      operator: { openId: 'ou_manager' },
      action: { value: { something: 'else' } },
    });
    expect(h.updatedCards).toHaveLength(1);
  });

  it('发起人在批复前被解绑：批准后不以旧角色续跑，原会话收到未执行提示', async () => {
    // 身份表里去掉 ou_rep（e007）——模拟单据开出后、批复前发起人被解绑
    const store = new MemoryApprovalStore();
    const invoked: Array<{ tool: string }> = [];
    const sent: Array<{ chatId: string; markdown: string }> = [];
    const deps: ApprovalCardDeps = {
      store,
      rbacBySystem: new Map([['twenty', rbacCrm]]),
      toolset: {
        invoke: async (_p, tool) => {
          invoked.push({ tool });
          return { kind: 'ok', data: {}, maskedFields: [] };
        },
      },
      identityMap: async () => ({ ou_manager: { userId: 'e005', role: 'sales_manager' } }),
      updateCard: async () => {},
      send: async (chatId, content) => {
        sent.push({ chatId, markdown: content.markdown });
      },
    };
    const record = await seedRecord(store);

    await handleCardAction(deps, click(record.id, 'approve', 'ou_manager'));

    expect((await store.get(record.id))?.status).toBe('approved');
    expect(invoked).toHaveLength(0); // 没有以旧角色续跑
    expect(sent.at(-1)?.markdown).toContain('无有效身份绑定');
    expect(sent.at(-1)?.chatId).toBe('oc_origin');
  });

  it('续跑结果的转述：ok 截断展示 / refusal 说明原因', () => {
    expect(summarizeResult({ kind: 'ok', data: { a: 1 }, maskedFields: [] })).toContain(
      '已执行完成',
    );
    expect(summarizeResult({ kind: 'refusal', reason: 'row_denied', rule: 'r' })).toContain(
      'row_denied',
    );
    const big = { text: 'x'.repeat(2000) };
    expect(summarizeResult({ kind: 'ok', data: big, maskedFields: [] }).length).toBeLessThan(700);
  });
});
