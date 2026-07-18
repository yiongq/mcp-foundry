import type { ApprovalRecord, ApprovalStore, GuardedResult, RbacConfig } from '@yiong/foundry-core';
import type { IdentityMap } from './identity.js';
import { resolvePrincipal } from './identity.js';
import type { GuardedToolset } from './toolset.js';

/**
 * 飞书侧的审批环节：出卡片（同意/拒绝按钮）→ 长连接收 card.action.trigger 回调
 * → 校验点按人是本域 approver → 批复落库 → 卡片原地翻面 → 批准则自动续跑
 * （以发起人身份重新走守卫管线，闸门命中已批准单即消费放行）→ 结果推回原会话。
 *
 * 点按人身份在回调时刻重新解析（identityMap 热重载生效）——审批权是点按时刻的
 * 角色判定，不是"拿到卡片的人就能批"。
 */

export interface CardActionEventLike {
  messageId: string;
  chatId: string;
  operator: { openId: string };
  action: { value?: unknown };
}

export interface ApprovalCardDeps {
  store: ApprovalStore;
  /** 系统名 → 该域 RBAC（approver 标记按域裁决） */
  rbacBySystem: ReadonlyMap<string, RbacConfig>;
  toolset: Pick<GuardedToolset, 'invoke'>;
  identityMap: () => Promise<IdentityMap>;
  updateCard: (messageId: string, card: Record<string, unknown>) => Promise<unknown>;
  send: (chatId: string, content: { markdown: string }) => Promise<unknown>;
}

const shortId = (id: string): string => id.slice(0, 8);

function argsBlock(args: Record<string, unknown>): string {
  const json = JSON.stringify(args, null, 2);
  return json.length > 800 ? `${json.slice(0, 800)}…` : json;
}

function cardBody(record: ApprovalRecord): Array<Record<string, unknown>> {
  return [
    {
      tag: 'div',
      fields: [
        {
          is_short: true,
          text: { tag: 'lark_md', content: `**发起人**\n${record.userId}（${record.role}）` },
        },
        { is_short: true, text: { tag: 'lark_md', content: `**系统**\n${record.system}` } },
        { is_short: true, text: { tag: 'lark_md', content: `**操作**\n${record.tool}` } },
        {
          is_short: true,
          text: {
            tag: 'lark_md',
            content: `**有效期至**\n${record.expiresAt.slice(0, 19).replace('T', ' ')}`,
          },
        },
      ],
    },
    {
      tag: 'div',
      text: { tag: 'lark_md', content: `**参数**\n\`\`\`\n${argsBlock(record.args)}\n\`\`\`` },
    },
  ];
}

/** 待批卡：橙头 + 同意/拒绝按钮，按钮 value 携带单号与决定 */
export function buildApprovalCard(record: ApprovalRecord): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: 'orange',
      title: { tag: 'plain_text', content: `🛂 审批单 #${shortId(record.id)} 待批复` },
    },
    elements: [
      ...cardBody(record),
      {
        tag: 'action',
        actions: [
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '同意' },
            type: 'primary',
            value: { approvalId: record.id, decision: 'approve' },
          },
          {
            tag: 'button',
            text: { tag: 'plain_text', content: '拒绝' },
            type: 'danger',
            value: { approvalId: record.id, decision: 'deny' },
          },
        ],
      },
    ],
  };
}

/** 已决卡：翻面后不再有按钮，头色随结果 */
export function buildDecidedCard(
  record: ApprovalRecord,
  outcome: 'approved' | 'denied' | 'expired',
  detail: string,
): Record<string, unknown> {
  const header = {
    approved: { template: 'green', title: `✅ 审批单 #${shortId(record.id)} 已批准` },
    denied: { template: 'red', title: `❌ 审批单 #${shortId(record.id)} 已拒绝` },
    expired: { template: 'grey', title: `⏰ 审批单 #${shortId(record.id)} 已过期` },
  }[outcome];
  return {
    config: { wide_screen_mode: true },
    header: { template: header.template, title: { tag: 'plain_text', content: header.title } },
    elements: [...cardBody(record), { tag: 'div', text: { tag: 'lark_md', content: detail } }],
  };
}

/** 守卫结果 → 推回原会话的一句话摘要；ok 的 data 截断展示（原会话属于发起人本人） */
export function summarizeResult(result: GuardedResult): string {
  if (result.kind === 'ok') {
    const json = JSON.stringify(result.data);
    return `已执行完成，结果：${json.length > 600 ? `${json.slice(0, 600)}…` : json}`;
  }
  if (result.kind === 'refusal') return `执行被守卫拒绝（${result.reason}）`;
  if (result.kind === 'pending') return '执行仍处于待审批状态（异常，请联系管理员）';
  return `执行出错：${result.message}`;
}

function parseActionValue(
  value: unknown,
): { approvalId: string; decision: 'approve' | 'deny' } | null {
  // v2 回调 value 是对象；有些通道会给 JSON 字符串——两种都接
  const obj =
    typeof value === 'string'
      ? (() => {
          try {
            return JSON.parse(value) as unknown;
          } catch {
            return null;
          }
        })()
      : value;
  if (typeof obj !== 'object' || obj === null) return null;
  const { approvalId, decision } = obj as { approvalId?: unknown; decision?: unknown };
  if (typeof approvalId !== 'string') return null;
  if (decision !== 'approve' && decision !== 'deny') return null;
  return { approvalId, decision };
}

export async function handleCardAction(
  deps: ApprovalCardDeps,
  evt: CardActionEventLike,
): Promise<void> {
  const parsed = parseActionValue(evt.action.value);
  if (!parsed) return; // 不是审批卡的回调，别的卡片交互不归这里管

  const record = await deps.store.get(parsed.approvalId);
  if (!record) {
    await deps.updateCard(evt.messageId, {
      config: { wide_screen_mode: true },
      header: {
        template: 'grey',
        title: { tag: 'plain_text', content: '⚠️ 审批单不存在（可能已清理或服务重启前开出）' },
      },
      elements: [],
    });
    return;
  }

  const identityMap = await deps.identityMap();
  const operator = resolvePrincipal(identityMap, evt.operator.openId);
  if (operator === null) {
    await deps.send(evt.chatId, { markdown: '⛔ 你的身份未绑定，无法批复审批单。' });
    return;
  }
  const isApprover = deps.rbacBySystem.get(record.system)?.roles[operator.role]?.approver === true;
  if (!isApprover) {
    await deps.send(evt.chatId, {
      markdown: `⛔ 身份 ${operator.userId}（${operator.role}）不是 ${record.system} 域的审批人，无权批复。`,
    });
    return;
  }

  if (record.status !== 'pending') {
    // 幂等：已被别人（或自己重复）批过，卡片翻到当前状态即可
    await deps.updateCard(
      evt.messageId,
      buildDecidedCard(
        record,
        record.status,
        `审批人：${record.approverId ?? '?'} · ${record.decidedAt?.slice(0, 19).replace('T', ' ') ?? ''}`,
      ),
    );
    return;
  }

  const decision = parsed.decision === 'approve' ? 'approved' : 'denied';
  let decided: ApprovalRecord;
  try {
    decided = await deps.store.decide(record.id, decision, operator.userId);
  } catch (err) {
    // 过期/竞态：翻灰卡说明
    await deps.updateCard(
      evt.messageId,
      buildDecidedCard(record, 'expired', err instanceof Error ? err.message : String(err)),
    );
    return;
  }

  await deps.updateCard(
    evt.messageId,
    buildDecidedCard(decided, decision, `审批人：${operator.userId}（${operator.role}）`),
  );

  const originChatId = decided.meta?.chatId;
  if (decision === 'denied') {
    if (originChatId !== undefined) {
      await deps.send(originChatId, {
        markdown: `❌ 审批单 #${shortId(decided.id)}（${decided.tool}）已被 ${operator.userId} 拒绝，操作不会执行。`,
      });
    }
    return;
  }

  // 批准 → 自动续跑，但发起人身份按当前身份表重新解析（不用单据里落库的旧角色）：
  // 单据可能开出后、批复前，发起人被解绑或降权——审批不是权限旁路，续跑必须按此刻的权限走。
  // HTTP 入口每次请求都重解身份，飞书续跑这里对齐同一纪律。
  const currentRequester = Object.values(identityMap).find((e) => e.userId === decided.userId);
  if (currentRequester === undefined) {
    if (originChatId !== undefined) {
      await deps.send(originChatId, {
        markdown: `⚠️ 审批单 #${shortId(decided.id)}（${decided.tool}）已批准，但发起人 ${decided.userId} 当前无有效身份绑定，操作未执行。`,
      });
    }
    return;
  }
  // 重新走完整守卫管线，闸门命中已批准单消费放行。行级过滤/脱敏照常生效。
  // 若发起人已降权到无此工具权限，守卫在白名单层就拒（tool_not_allowed），单据不被消费。
  const requester = { userId: currentRequester.userId, role: currentRequester.role };
  const result = await deps.toolset.invoke(requester, decided.tool, decided.args);
  if (originChatId !== undefined) {
    await deps.send(originChatId, {
      markdown: `✅ 审批单 #${shortId(decided.id)}（${decided.tool}）已由 ${operator.userId} 批准。${summarizeResult(result)}`,
    });
  }
}
