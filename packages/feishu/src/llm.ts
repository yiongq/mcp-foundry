import { z } from 'zod';
import type { LlmToolSpec } from './toolset.js';

/**
 * OpenAI 兼容 tool-calling 循环（智谱 GLM / DeepSeek / vLLM 通用）。
 * 模型只负责「说人话 + 选工具」；权限在守卫层，工具结果里的 refusal
 * 是给模型转述的裁决，不是模型能推翻的建议。
 */
export interface LlmOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 测试注入用；缺省全局 fetch */
  fetchImpl?: typeof fetch;
  /** 工具循环上限，防失控；缺省 6 */
  maxTurns?: number;
  temperature?: number;
  /** 关掉思考链（智谱 GLM 的 thinking 参数）——对话场景延迟优先；其他厂商忽略此项 */
  disableThinking?: boolean;
  /** 每轮 LLM 往返的耗时观测（定位慢在哪）；缺省不打 */
  onTiming?: (info: { turn: number; ms: number; toolCalls: number }) => void;
}

export type ToolExecutor = (tool: string, args: Record<string, unknown>) => Promise<string>;

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCallPayload[];
  tool_call_id?: string;
}

interface ToolCallPayload {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

const responseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.string().nullable().optional(),
          tool_calls: z
            .array(
              z.object({
                id: z.string(),
                type: z.literal('function'),
                function: z.object({ name: z.string(), arguments: z.string() }),
              }),
            )
            .optional(),
        }),
      }),
    )
    .min(1),
});

export async function runToolLoop(
  options: LlmOptions,
  systemPrompt: string,
  userText: string,
  tools: readonly LlmToolSpec[],
  execute: ToolExecutor,
): Promise<string> {
  const doFetch = options.fetchImpl ?? fetch;
  const maxTurns = options.maxTurns ?? 6;
  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userText },
  ];

  for (let turn = 0; turn < maxTurns; turn += 1) {
    const startedAt = Date.now();
    const response = await doFetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        temperature: options.temperature ?? 0.3,
        ...(options.disableThinking === true ? { thinking: { type: 'disabled' } } : {}),
        messages,
        ...(tools.length > 0
          ? {
              tools: tools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.parameters },
              })),
            }
          : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`LLM API ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }

    const { choices } = responseSchema.parse(await response.json());
    const message = choices[0]?.message;
    if (message === undefined) throw new Error('LLM 响应缺少 message');

    const toolCalls = message.tool_calls ?? [];
    options.onTiming?.({ turn: turn + 1, ms: Date.now() - startedAt, toolCalls: toolCalls.length });
    if (toolCalls.length === 0) {
      const content = message.content?.trim();
      if (content === undefined || content === '') throw new Error('LLM 返回了空回答');
      return content;
    }

    messages.push({
      role: 'assistant',
      content: message.content ?? null,
      tool_calls: toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: c.function,
      })),
    });

    for (const call of toolCalls) {
      let resultText: string;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        resultText = await execute(call.function.name, args);
      } catch (err) {
        resultText = JSON.stringify({
          kind: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
      messages.push({ role: 'tool', content: resultText, tool_call_id: call.id });
    }
  }

  throw new Error(`工具循环超过 ${maxTurns} 轮未收敛`);
}
