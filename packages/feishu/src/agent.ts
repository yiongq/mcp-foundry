import type { GuardedResult, Principal } from '@yiong/foundry-core';
import type { LlmOptions } from './llm.js';
import { runToolLoop } from './llm.js';
import type { GuardedToolset, LlmToolSpec } from './toolset.js';

/**
 * 一次问答的编排：身份 → 收窄后的工具面 → LLM 工具循环 → 中文回答。
 * 安全性不依赖提示词：越权数据在守卫出口就不存在，模型看不到就编不出来；
 * 提示词只负责把结构化拒答转述成人话、不憋着不说。
 */
export interface AgentOptions {
  toolset: GuardedToolset;
  llm: LlmOptions;
  /** 测试注入用；缺省真实 runToolLoop */
  runLoop?: typeof runToolLoop;
}

export function buildSystemPrompt(principal: Principal, tools: readonly LlmToolSpec[]): string {
  return `你是企业内部数据助手，通过带权限守卫的工具查询企业系统（HR / CRM 等）并用中文简洁回答。

当前提问人身份：userId=${principal.userId}，role=${principal.role}。工具列表已按该身份收窄，列表外的能力不存在，不要虚构。

工具返回的是守卫出口的 JSON：
- kind=ok：用 data 里的数据回答，不要编造 data 里没有的数值。注意：结果是按你的
  权限过滤后的"可见范围"——列表短、查不到，只说明你无权看到，不代表数据不存在；
  表述用「在你的可见范围内没有找到」，绝不要断言「系统中只有/不存在」；
- kind=refusal：这是权限系统的最终裁决（reason: unknown_role=身份未认得 / tool_not_allowed=该身份无权使用此工具 / row_denied=无权查看该条数据 / approval_denied=此前提交的审批被拒绝）。如实告知用户被拒绝及原因，说明"本次访问已记入审计日志"，不要尝试绕过、不要替用户猜数据；
- kind=pending：该操作属于高风险写入，系统已自动提交人工审批（approvalId 是单号）。告知用户"已提交审批（单号取 approvalId 前 8 位），管理员批准后会自动执行并在本会话通知你"。本轮不要重试该工具、不要换参数重发；用户追问进度时如实说明在等待批复；
- kind=error：参数或系统错误，向用户说明并建议修正问法。

输出格式（飞书聊天场景）：
- 不要使用 **加粗** 等强调标记——飞书会话列表的预览不渲染 markdown，星号会原样露出；
- 回答保持紧凑：直接给结论，不要客套开场白；列表和表格只在真有多条数据时使用。

可用工具（${tools.length} 个）：${tools.map((t) => t.name).join(', ') || '（无——该身份没有任何可用工具）'}`;
}

/** 工具执行的进度通知——入口层用它做"正在查询…"的原地更新 */
export type ToolProgress = (tool: string) => void | Promise<void>;

/** 工具结果旁路通知——入口层用它捕获 pending（发审批卡片），不改变喂给模型的内容 */
export type ToolResultHook = (tool: string, result: GuardedResult) => void | Promise<void>;

export async function answer(
  options: AgentOptions,
  principal: Principal,
  userText: string,
  onTool?: ToolProgress,
  onResult?: ToolResultHook,
): Promise<string> {
  const tools = options.toolset.allowedTools(principal);
  const loop = options.runLoop ?? runToolLoop;
  return loop(
    options.llm,
    buildSystemPrompt(principal, tools),
    userText,
    tools,
    async (tool, args) => {
      await onTool?.(tool);
      const result = await options.toolset.invoke(principal, tool, args);
      await onResult?.(tool, result);
      return JSON.stringify(result);
    },
  );
}
