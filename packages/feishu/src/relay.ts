// 飞书审批 relay：让飞书「只当审批人」。
//
// 与自成一体的 bot 不同,relay 不聊天、不嵌网关、不落自己的审批库、也不执行——它只是
// 网页网关(packages/server)那本审批库的一个远程审批 UI:
//   ① 轮询网关 GET /approvals 拿待审批单 → 给审批人发飞书卡片
//   ② 审批人点「同意/拒绝」→ 把决定回传给网关 POST /approvals/{id}(以审批人身份)
//   ③ 执行仍由发起人在网页侧重试消票完成(网关是唯一真源,relay 不碰执行)
//
// 于是:网页 = 发起人,飞书 = 独立审批人,职责分离由网关代码级 self-approval 不变量兜底。
import type { ApprovalRecord } from '@yiong/foundry-core';
import { buildApprovalCard, buildDecidedCard, parseActionValue } from './approval.js';

/** 网关 GET /approvals 返回的单条待审批(requester 嵌套,与卡片用的扁平 record 不同)。 */
export interface PendingRecord {
  id: string;
  system: string;
  tool: string;
  args: Record<string, unknown>;
  requester: { userId: string; role: string };
  expiresAt: string;
}

/** relay 对网关审批端点的最小视图(以审批人身份认证)。 */
export interface GatewayApprovals {
  listPending(): Promise<PendingRecord[]>;
  decide(id: string, decision: 'approve' | 'deny'): Promise<{ status: number; error?: string }>;
}

/** relay 对飞书卡片的最小视图(发卡到审批会话 / 点卡后翻面)。 */
export interface RelayCards {
  send(card: Record<string, unknown>): Promise<void>;
  update(messageId: string, card: Record<string, unknown>): Promise<void>;
}

export interface CardActionLike {
  messageId: string;
  action: { value: unknown };
}

/** 网关的嵌套 requester 形状 → 卡片用的扁平 ApprovalRecord(cardBody 只读 userId/role/system/tool/args/expiresAt)。 */
function toRecord(p: PendingRecord): ApprovalRecord {
  return {
    id: p.id,
    system: p.system,
    tool: p.tool,
    args: p.args,
    argsHash: '',
    userId: p.requester.userId,
    role: p.requester.role,
    status: 'pending',
    createdAt: '',
    expiresAt: p.expiresAt,
  };
}

/**
 * 拉一轮网关待审批单,给每张「还没发过卡」的单发审批卡。
 * seen: approvalId → 该单的 record(点卡翻面时复用,展示真实归属/参数)。
 */
export async function relayPendingToCards(
  gateway: GatewayApprovals,
  cards: RelayCards,
  seen: Map<string, ApprovalRecord>,
): Promise<void> {
  const pending = await gateway.listPending();
  for (const p of pending) {
    if (seen.has(p.id)) continue;
    const record = toRecord(p);
    await cards.send(buildApprovalCard(record));
    seen.set(p.id, record);
  }
}

/**
 * 审批人点卡 → 把决定回传给网关(网关是真源;relay 不执行、不落库),按网关结果翻卡。
 * 非审批卡的回调忽略。网关拒绝(如 403 自审批 / 409 已决)如实翻灰说明。
 */
export async function relayCardDecision(
  evt: CardActionLike,
  gateway: GatewayApprovals,
  cards: RelayCards,
  seen: Map<string, ApprovalRecord>,
): Promise<void> {
  const parsed = parseActionValue(evt.action.value);
  if (!parsed) return;

  const record =
    seen.get(parsed.approvalId) ??
    toRecord({
      id: parsed.approvalId,
      system: '',
      tool: '',
      args: {},
      requester: { userId: '', role: '' },
      expiresAt: '',
    });

  const res = await gateway.decide(parsed.approvalId, parsed.decision);
  if (res.status !== 200) {
    await cards.update(
      evt.messageId,
      buildDecidedCard(record, 'expired', `批复未生效：${res.error ?? `HTTP ${res.status}`}`),
    );
    return;
  }
  await cards.update(
    evt.messageId,
    parsed.decision === 'approve'
      ? buildDecidedCard(
          record,
          'approved',
          '已批准。发起人在网页侧重试即消票执行——审批人不碰执行。',
        )
      : buildDecidedCard(record, 'denied', '已拒绝，操作不会执行。'),
  );
}

/** 以审批人身份连网关审批端点的 HTTP 客户端(headers 带审批人身份:demo 头或 Bearer 令牌)。 */
export function createGatewayApprovals(
  baseUrl: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): GatewayApprovals {
  const base = baseUrl.replace(/\/+$/, '');
  return {
    async listPending(): Promise<PendingRecord[]> {
      // 轮询网关不能被卡死的连接无限挂起（否则整条 relay 轮询停摆）
      const res = await fetchImpl(`${base}/approvals`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`GET /approvals → HTTP ${res.status}`);
      const body = (await res.json()) as { approvals?: PendingRecord[] };
      return body.approvals ?? [];
    },
    async decide(id, decision): Promise<{ status: number; error?: string }> {
      const res = await fetchImpl(`${base}/approvals/${encodeURIComponent(id)}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ decision }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status === 200) return { status: 200 };
      let error: string | undefined;
      try {
        error = ((await res.json()) as { error?: string }).error;
      } catch {
        error = undefined;
      }
      return error === undefined ? { status: res.status } : { status: res.status, error };
    },
  };
}
