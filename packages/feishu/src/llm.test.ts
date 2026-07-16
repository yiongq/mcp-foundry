import { describe, expect, it } from 'vitest';
import { runToolLoop } from './llm.js';
import type { LlmToolSpec } from './toolset.js';

const TOOLS: LlmToolSpec[] = [
  {
    name: 'get_leave_balance',
    description: '查年假',
    parameters: { type: 'object', properties: { employee_id: { type: 'string' } } },
  },
];

interface RequestLog {
  body: {
    model: string;
    messages: Array<{ role: string; content: string | null; tool_call_id?: string }>;
    tools?: unknown[];
  };
}

function fakeLlm(responses: unknown[]): { fetchImpl: typeof fetch; requests: RequestLog[] } {
  const requests: RequestLog[] = [];
  let i = 0;
  return {
    requests,
    fetchImpl: (async (_url: unknown, init: unknown) => {
      requests.push({ body: JSON.parse(String((init as RequestInit).body)) as RequestLog['body'] });
      const body = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  };
}

const OPTS = { baseUrl: 'https://llm.test/v4', apiKey: 'k', model: 'm' };

describe('runToolLoop', () => {
  it('无工具调用直接返回文本', async () => {
    const { fetchImpl, requests } = fakeLlm([
      { choices: [{ message: { content: '你好，有什么可以帮你？' } }] },
    ]);

    const text = await runToolLoop({ ...OPTS, fetchImpl }, 'sys', '你好', TOOLS, async () => '');

    expect(text).toBe('你好，有什么可以帮你？');
    expect(requests[0]?.body.tools).toHaveLength(1);
    expect(requests[0]?.body.messages[0]).toMatchObject({ role: 'system', content: 'sys' });
  });

  it('tool_calls → 执行 → 结果回填 → 二轮出答案', async () => {
    const { fetchImpl, requests } = fakeLlm([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: {
                    name: 'get_leave_balance',
                    arguments: '{"employee_id":"e002"}',
                  },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: '你还有 7 天年假。' } }] },
    ]);

    const executed: Array<[string, Record<string, unknown>]> = [];
    const text = await runToolLoop(
      { ...OPTS, fetchImpl },
      'sys',
      '我还有几天年假',
      TOOLS,
      async (tool, args) => {
        executed.push([tool, args]);
        return JSON.stringify({ kind: 'ok', data: { annual_left: 7 } });
      },
    );

    expect(text).toBe('你还有 7 天年假。');
    expect(executed).toEqual([['get_leave_balance', { employee_id: 'e002' }]]);
    // 第二轮请求里应有 assistant(tool_calls) + tool 结果两条消息
    const secondRoles = requests[1]?.body.messages.map((m) => m.role);
    expect(secondRoles).toEqual(['system', 'user', 'assistant', 'tool']);
    expect(requests[1]?.body.messages[3]?.tool_call_id).toBe('call_1');
  });

  it('工具参数不是合法 JSON 时按 error 结果回填，不炸循环', async () => {
    const { fetchImpl } = fakeLlm([
      {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'c1',
                  type: 'function',
                  function: { name: 'get_leave_balance', arguments: '{oops' },
                },
              ],
            },
          },
        ],
      },
      { choices: [{ message: { content: '参数有误，请再说一次。' } }] },
    ]);

    const text = await runToolLoop({ ...OPTS, fetchImpl }, 'sys', 'x', TOOLS, async () => 'ok');
    expect(text).toBe('参数有误，请再说一次。');
  });

  it('超过 maxTurns 不收敛 → 抛错', async () => {
    const toolCallForever = {
      choices: [
        {
          message: {
            content: null,
            tool_calls: [
              {
                id: 'c',
                type: 'function',
                function: { name: 'get_leave_balance', arguments: '{}' },
              },
            ],
          },
        },
      ],
    };
    const { fetchImpl } = fakeLlm([toolCallForever]);

    await expect(
      runToolLoop({ ...OPTS, fetchImpl, maxTurns: 2 }, 'sys', 'x', TOOLS, async () => '{}'),
    ).rejects.toThrow(/未收敛/);
  });

  it('HTTP 非 200 → 抛错', async () => {
    const fetchImpl = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    await expect(
      runToolLoop({ ...OPTS, fetchImpl }, 'sys', 'x', [], async () => ''),
    ).rejects.toThrow('LLM API 429');
  });
});
