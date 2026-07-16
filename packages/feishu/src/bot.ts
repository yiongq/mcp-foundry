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
  /** 静态映射，或每条消息调用的加载器——后者支持改绑定免重启（见 serve.ts） */
  identityMap: IdentityMap | (() => Promise<IdentityMap>);
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
    chatType: 'p2p' | 'group';
    messageId: string;
    content?: string;
  }): Promise<void> => {
    console.log(`[bot] 收到消息 sender=${msg.senderId} chat=${msg.chatId}`);
    const text = msg.content?.trim();
    if (!text) return;

    // 单聊不开线程：replyTo 会把每条答案变成带引用头的 thread 回复，
    // 一对一会话里纯属噪音；群聊保留，多人语境下引用有定位价值。
    const sendOpts = msg.chatType === 'p2p' ? undefined : { replyTo: msg.messageId };

    const identityMap =
      typeof config.identityMap === 'function' ? await config.identityMap() : config.identityMap;
    const principal = resolvePrincipal(identityMap, msg.senderId);
    if (principal === null) {
      await channel.send(
        msg.chatId,
        {
          markdown:
            `你的身份还没有绑定，暂时不能查询任何数据。\n\n` +
            `你的 open_id：\`${msg.senderId}\`\n\n` +
            `请管理员把它写进 \`config/identity.feishu.yaml\`（保存即生效，无需重启），例如：\n` +
            `\`\`\`yaml\nidentities:\n  ${msg.senderId}: { userId: e002, role: employee }\n\`\`\``,
        },
        sendOpts,
      );
      return;
    }

    const startedAt = Date.now();
    const signature = (reply: string): string =>
      `${reply}\n\n—\n身份：${principal.userId}（${principal.role}）· 全程审计 · ${((Date.now() - startedAt) / 1000).toFixed(1)}s`;

    // 处理中反馈用表情回应挂在用户消息上，答完摘掉——两个被否掉的方案：
    // 占位卡原地 setContent（飞书不对卡片更新重新锚定视口，长答案下半截留在屏幕外）、
    // 占位卡发完撤回（留下"撤回了一条消息"灰条）。答案始终作为新消息发出，
    // 新消息才触发飞书的自动滚屏。表情失败（如缺权限）只降级掉进度提示，不影响作答。
    const reactionId = await channel.addReaction(msg.messageId, 'OnIt').catch((err: unknown) => {
      console.error('[bot] 表情回应失败（不影响作答）:', errText(err));
      return null;
    });
    try {
      const reply = await answer(config.agent, principal, text, (tool) => {
        console.log(`[bot] 执行工具 ${tool}`);
      });
      await channel.send(msg.chatId, { markdown: signature(reply) }, sendOpts);
    } catch (err) {
      // 错误细节只进日志，不进聊天——出口纪律与守卫一致
      console.error('[bot] 处理消息失败:', errText(err));
      await channel.send(
        msg.chatId,
        { markdown: '服务暂时开小差了，请稍后再试（详情已记录日志）。' },
        sendOpts,
      );
    } finally {
      if (reactionId !== null) {
        await channel.removeReaction(msg.messageId, reactionId).catch(() => {
          // 摘表情失败无感知成本，静默
        });
      }
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
