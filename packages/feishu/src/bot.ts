import { createLarkChannel, LoggerLevel } from '@larksuiteoapi/node-sdk';
import type { AgentOptions } from './agent.js';
import { answer } from './agent.js';
import type { IdentityMap } from './identity.js';
import { resolvePrincipal } from './identity.js';

/**
 * 飞书入口层（长连接，无需公网回调）。
 * 身份来自事件里的 sender open_id（飞书服务端签发）→ identity 映射表 → principal。
 * 未绑定的用户不给任何数据面，只回自己的 open_id 引导管理员绑定。
 */
export interface BotConfig {
  appId: string;
  appSecret: string;
  identityMap: IdentityMap;
  agent: AgentOptions;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function startBot(config: BotConfig): Promise<{ close: () => Promise<void> }> {
  const channel = createLarkChannel({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: LoggerLevel.warn,
    // 单聊直接答，群里要 @ 才答——避免旁听群消息
    policy: { requireMention: true, dmMode: 'open' },
  });

  const handleMessage = async (msg: {
    senderId: string;
    chatId: string;
    messageId: string;
    content?: string;
  }): Promise<void> => {
    console.log(`[bot] 收到消息 sender=${msg.senderId} chat=${msg.chatId}`);
    const text = msg.content?.trim();
    if (!text) return;

    const principal = resolvePrincipal(config.identityMap, msg.senderId);
    if (principal === null) {
      await channel.send(
        msg.chatId,
        {
          markdown:
            `你的身份还没有绑定，暂时不能查询任何数据。\n\n` +
            `你的 open_id：\`${msg.senderId}\`\n\n` +
            `请管理员把它写进 \`config/identity.feishu.yaml\` 并重启 bot，例如：\n` +
            `\`\`\`yaml\nidentities:\n  ${msg.senderId}: { userId: e002, role: employee }\n\`\`\``,
        },
        { replyTo: msg.messageId },
      );
      return;
    }

    const startedAt = Date.now();
    // answer 只跑一次：流式半路失败时，回退路径复用同一个 promise，不重复调 LLM/不重复写审计
    let answerPromise: Promise<string> | null = null;
    const getAnswer = (onTool?: (tool: string) => void | Promise<void>): Promise<string> => {
      answerPromise ??= answer(config.agent, principal, text, onTool);
      return answerPromise;
    };
    const signature = (reply: string): string =>
      `${reply}\n\n—\n身份：${principal.userId}（${principal.role}）· 全程审计 · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

    try {
      // 首选流式占位：消息立刻出现"正在查询"，工具执行时原地更新，最后原地变成答案。
      // 底层走 cardkit 卡片实体，需要应用有 cardkit 权限。
      await channel.stream(
        msg.chatId,
        {
          markdown: async (ctl) => {
            await ctl.setContent('🔍 正在理解问题…');
            try {
              const reply = await getAnswer((tool) =>
                ctl.setContent(`⚙️ 正在执行 \`${tool}\`（守卫审计中）…`),
              );
              await ctl.setContent(signature(reply));
            } catch (err) {
              // 错误细节只进日志，不进聊天——出口纪律与守卫一致
              console.error('[bot] 处理消息失败:', errText(err));
              await ctl.setContent('服务暂时开小差了，请稍后再试（详情已记录日志）。');
            }
          },
        },
        { replyTo: msg.messageId },
      );
    } catch (err) {
      // 流式不可用（如缺 cardkit 权限）→ 回退一次性纯文本，功能不打折
      console.error('[bot] 流式发送不可用，回退纯文本:', errText(err));
      const reply = await getAnswer().catch((answerErr: unknown) => {
        console.error('[bot] 处理消息失败:', errText(answerErr));
        return null;
      });
      await channel.send(
        msg.chatId,
        {
          markdown:
            reply === null ? '服务暂时开小差了，请稍后再试（详情已记录日志）。' : signature(reply),
        },
        { replyTo: msg.messageId },
      );
    }
    console.log(`[bot] 应答完成 ${Date.now() - startedAt}ms`);
  };

  channel.on('message', (msg) => {
    // 顶层兜底：任何未捕获异常只记日志，绝不放出去炸掉进程
    handleMessage(msg).catch((err: unknown) => {
      console.error('[bot] 未捕获异常:', errText(err));
    });
  });

  await channel.connect();
  const identity = channel.botIdentity;
  console.log(`[bot] 已连接：${identity ? identity.name : '(未知身份)'}，长连接就绪`);
  return { close: () => channel.disconnect() };
}
