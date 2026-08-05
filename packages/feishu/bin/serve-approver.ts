/**
 * 飞书审批 relay 入口：飞书「只当审批人」。
 *
 * 轮询网页网关(packages/server)的待审批单 → 给审批人发飞书卡片 → 审批人点「同意/拒绝」→
 * 回传网关 POST /approvals/{id}。不聊天、不嵌网关、不落自己的库、不执行——网关是唯一真源,
 * 执行仍由发起人在网页侧重试消票完成。于是:网页=发起人,飞书=独立审批人。
 *
 * 环境变量(缺省从本包 .env 读；已存在的环境变量优先):
 *   FEISHU_APP_ID / FEISHU_APP_SECRET     企业自建应用凭据(需订阅 card.action.trigger 长连接)
 *   FEISHU_APPROVAL_CHAT_ID               审批卡片投递的会话 id(审批人所在)
 *   FOUNDRY_GATEWAY_URL                   网页网关根,默认 http://127.0.0.1:3100
 *   审批人身份(二选一):
 *     FOUNDRY_APPROVER_TOKEN              签名 Bearer 令牌(生产 JWKS/HS256)
 *     FOUNDRY_APPROVER_USER + _ROLE       demo 头身份(本地 fixture,如 e005/sales_manager)
 *   FOUNDRY_APPROVER_POLL_MS              轮询间隔毫秒,默认 5000
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createLarkChannel, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { ApprovalRecord } from '@yiong/foundry-core';
import { createGatewayApprovals, relayCardDecision, relayPendingToCards } from '../src/relay.js';

/** 极简 .env 装载：KEY=VALUE 逐行；已有环境变量优先(便于临时覆盖)。同 bin/serve.ts。 */
function loadDotEnv(url: URL): void {
  let text: string;
  try {
    text = readFileSync(fileURLToPath(url), 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match?.[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}
loadDotEnv(new URL('../.env', import.meta.url));

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`缺少环境变量 ${name}（填在 packages/feishu/.env）`);
  }
  return value;
}

const appId = required('FEISHU_APP_ID');
const appSecret = required('FEISHU_APP_SECRET');
const chatId = required('FEISHU_APPROVAL_CHAT_ID');
const gatewayUrl = process.env.FOUNDRY_GATEWAY_URL ?? 'http://127.0.0.1:3100';
const pollMs = Number(process.env.FOUNDRY_APPROVER_POLL_MS ?? '5000');

// 审批人身份：签名令牌优先,否则 demo 头。二者都无则拒绝启动(审批人必须有身份)。
const token = process.env.FOUNDRY_APPROVER_TOKEN;
const approverUser = process.env.FOUNDRY_APPROVER_USER;
const approverRole = process.env.FOUNDRY_APPROVER_ROLE;
let headers: Record<string, string>;
let who: string;
if (token) {
  headers = { authorization: `Bearer ${token}` };
  who = 'signed token';
} else if (approverUser && approverRole) {
  headers = { 'x-foundry-user': approverUser, 'x-foundry-role': approverRole };
  who = `demo ${approverUser}/${approverRole}`;
} else {
  throw new Error(
    '审批人身份未配置：设 FOUNDRY_APPROVER_TOKEN（签名令牌）或 FOUNDRY_APPROVER_USER + FOUNDRY_APPROVER_ROLE（demo 头）',
  );
}

const gateway = createGatewayApprovals(gatewayUrl, headers);
const seen = new Map<string, ApprovalRecord>();

const channel = createLarkChannel({
  appId,
  appSecret,
  // 排障时 FEISHU_LOG_LEVEL=debug 可看到 SDK 内部「safety: drop duplicate/in-flight action」
  // 这类静默丢弃——它们不走 error 事件,不开 debug 就查不到。
  loggerLevel:
    process.env.FEISHU_LOG_LEVEL === 'debug'
      ? LoggerLevel.debug
      : process.env.FEISHU_LOG_LEVEL === 'info'
        ? LoggerLevel.info
        : LoggerLevel.warn,
  policy: { requireMention: true, dmMode: 'open' },
});

const cards = {
  send: async (card: Record<string, unknown>): Promise<void> => {
    await channel.send(chatId, { card });
  },
  update: async (messageId: string, card: Record<string, unknown>): Promise<void> => {
    await channel.updateCard(messageId, card);
  },
};

// WS 生命周期：卡片「发」走 HTTP、「点」走 WS 长连接——WS 悄悄断掉时发卡照常、点按却全无
// 反应,且此前一个 handler 都没注册,故障完全静音。这几条日志是排障的唯一抓手。
channel.on('error', (err: Error) => {
  console.error('[approver] 通道错误:', err.message);
});
channel.on('reconnecting', () => {
  console.warn('[approver] WS 重连中……(此间卡片点按不会到达)');
});
channel.on('reconnected', () => {
  console.log('[approver] WS 已重连');
});

channel.on('cardAction', (evt: { messageId: string; action: { value: unknown } }) => {
  console.log(`[approver] 收到卡片点按 message=${evt.messageId} value=${JSON.stringify(evt.action.value)}`);
  void relayCardDecision(
    { messageId: evt.messageId, action: { value: evt.action.value } },
    gateway,
    cards,
    seen,
  ).catch((err: unknown) => {
    console.error('[approver] 卡片回调失败:', err instanceof Error ? err.message : String(err));
  });
});

const poll = (): void => {
  void relayPendingToCards(gateway, cards, seen).catch((err: unknown) => {
    console.error('[approver] 轮询网关失败:', err instanceof Error ? err.message : String(err));
  });
};

// WS 健康度：只在状态变化时打一行,免得刷屏。发卡走 HTTP 不受影响,所以
// 「卡片能收到但点了没反应」时,这里是唯一能看出 WS 已死的地方。
let lastWsState: string | undefined;
const reportWs = (): void => {
  const state = channel.getConnectionStatus()?.state ?? '(无 WSClient)';
  if (state !== lastWsState) {
    console.log(`[approver] WS 状态：${lastWsState ?? '—'} → ${state}`);
    lastWsState = state;
  }
};

await channel.connect();
const identity = channel.botIdentity;
console.log(
  `[approver] 已连接：${identity ? identity.name : '(未知)'}；审批人=${who}；网关=${gatewayUrl}；每 ${pollMs}ms 轮询待审批单`,
);
reportWs();
poll();
setInterval(() => {
  reportWs();
  poll();
}, pollMs);
