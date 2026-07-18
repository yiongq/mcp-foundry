import type { ApprovalRecord } from '@yiong/foundry-core';
import { describe, expect, it, vi } from 'vitest';
import {
  createGatewayApprovals,
  type GatewayApprovals,
  type PendingRecord,
  type RelayCards,
  relayCardDecision,
  relayPendingToCards,
} from './relay.js';

const PENDING: PendingRecord = {
  id: 'ap-1',
  system: 'twenty',
  tool: 'issue_refund',
  args: { order_id: 'ord-1004', amount: 600 },
  requester: { userId: 'e007', role: 'sales_rep' },
  expiresAt: '2026-07-19T00:00:00.000Z',
};

function makeCards() {
  const sent: Record<string, unknown>[] = [];
  const updated: Array<{ messageId: string; card: Record<string, unknown> }> = [];
  const impl: RelayCards = {
    send: async (card) => {
      sent.push(card);
    },
    update: async (messageId, card) => {
      updated.push({ messageId, card });
    },
  };
  return { impl, sent, updated };
}

const template = (card: Record<string, unknown> | undefined): unknown =>
  card ? (card.header as { template?: unknown } | undefined)?.template : undefined;

describe('飞书审批 relay（飞书只当审批人）', () => {
  it('轮询网关待审批 → 给每张新单发卡；重复轮询同一张单不重发', async () => {
    const gateway: GatewayApprovals = {
      listPending: vi.fn(async () => [PENDING]),
      decide: vi.fn(),
    };
    const c = makeCards();
    const seen = new Map<string, ApprovalRecord>();

    await relayPendingToCards(gateway, c.impl, seen);
    await relayPendingToCards(gateway, c.impl, seen);

    expect(c.sent).toHaveLength(1); // 去重：只发一次
    expect(template(c.sent[0])).toBe('orange'); // 待批卡橙头
    expect(seen.has('ap-1')).toBe(true);
  });

  it('点同意 → 回传网关 decide(approve)，卡片翻绿（relay 不执行）', async () => {
    const decide = vi.fn(async () => ({ status: 200 }));
    const gateway: GatewayApprovals = { listPending: vi.fn(), decide };
    const c = makeCards();

    await relayCardDecision(
      { messageId: 'm1', action: { value: { approvalId: 'ap-1', decision: 'approve' } } },
      gateway,
      c.impl,
      new Map(),
    );

    expect(decide).toHaveBeenCalledWith('ap-1', 'approve');
    expect(c.updated[0]?.messageId).toBe('m1');
    expect(template(c.updated[0]?.card)).toBe('green');
  });

  it('点拒绝 → decide(deny)，卡片翻红', async () => {
    const decide = vi.fn(async () => ({ status: 200 }));
    const gateway: GatewayApprovals = { listPending: vi.fn(), decide };
    const c = makeCards();

    await relayCardDecision(
      { messageId: 'm2', action: { value: { approvalId: 'ap-1', decision: 'deny' } } },
      gateway,
      c.impl,
      new Map(),
    );

    expect(decide).toHaveBeenCalledWith('ap-1', 'deny');
    expect(template(c.updated[0]?.card)).toBe('red');
  });

  it('网关拒绝自审批（403）→ 卡片翻灰说明，不显示为已批准', async () => {
    const decide = vi.fn(async () => ({ status: 403, error: 'self-approval forbidden' }));
    const gateway: GatewayApprovals = { listPending: vi.fn(), decide };
    const c = makeCards();

    await relayCardDecision(
      { messageId: 'm3', action: { value: { approvalId: 'ap-1', decision: 'approve' } } },
      gateway,
      c.impl,
      new Map(),
    );

    expect(template(c.updated[0]?.card)).toBe('grey');
    expect(JSON.stringify(c.updated[0]?.card)).toContain('self-approval');
  });

  it('非审批卡的回调被忽略：不 decide、不翻卡', async () => {
    const decide = vi.fn();
    const gateway: GatewayApprovals = { listPending: vi.fn(), decide };
    const c = makeCards();

    await relayCardDecision(
      { messageId: 'm4', action: { value: { foo: 'bar' } } },
      gateway,
      c.impl,
      new Map(),
    );

    expect(decide).not.toHaveBeenCalled();
    expect(c.updated).toHaveLength(0);
  });

  it('createGatewayApprovals：listPending 解 body.approvals；decide POST 带 {decision}', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith('/approvals') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify({ approvals: [PENDING] }), { status: 200 });
      }
      return new Response(JSON.stringify({ status: 'approved' }), { status: 200 });
    }) as typeof fetch;

    const gw = createGatewayApprovals(
      'https://gw.example.com/',
      { 'x-foundry-user': 'e005', 'x-foundry-role': 'sales_manager' },
      fetchImpl,
    );

    const pending = await gw.listPending();
    expect(pending[0]?.id).toBe('ap-1');

    const res = await gw.decide('ap-1', 'approve');
    expect(res.status).toBe(200);
    expect(calls[1]?.url).toBe('https://gw.example.com/approvals/ap-1');
    expect(JSON.parse((calls[1]?.init?.body as string) ?? '{}')).toEqual({ decision: 'approve' });
  });
});
