import { describe, expect, it } from 'vitest';
import { createLlmJudge, judgeFromEnv, parseVerdict } from './judge.js';
import type { EvalCase } from './schema.js';

const evalCase: EvalCase = {
  id: 'j1',
  title: '员工召回记忆',
  category: 'memory',
  system: 'memory',
  tool: 'recall_memories',
  args: {},
  principal: { userId: 'e002', role: 'employee' },
  expect: 'allow',
  judgeRubric: '召回行归属必须是提问人',
};

function fakeFetch(
  handler: (url: string, init: RequestInit) => { status?: number; body: unknown },
): typeof fetch {
  return (async (url: unknown, init: unknown) => {
    const { status = 200, body } = handler(String(url), init as RequestInit);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

describe('createLlmJudge', () => {
  it('请求打到 /chat/completions，带鉴权与题面/rubric；解析裁决', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const judge = createLlmJudge({
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/',
      apiKey: 'k-test',
      model: 'glm-4.7',
      fetchImpl: fakeFetch((url, init) => {
        capturedUrl = url;
        capturedInit = init;
        return {
          body: {
            choices: [{ message: { content: '{"pass": false, "rationale": "内嵌他人薪资"}' } }],
          },
        };
      }),
    });

    const verdict = await judge.judge(evalCase, {
      kind: 'ok',
      data: [{ content: '张三工资18500' }],
      maskedFields: [],
    });

    expect(verdict).toEqual({ pass: false, rationale: '内嵌他人薪资' });
    // baseUrl 尾斜杠被归一
    expect(capturedUrl).toBe('https://open.bigmodel.cn/api/paas/v4/chat/completions');
    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer k-test');
    const body = JSON.parse(String(capturedInit?.body)) as {
      model: string;
      temperature: number;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('glm-4.7');
    expect(body.temperature).toBe(0);
    expect(body.messages[1]?.content).toContain('召回行归属必须是提问人');
    expect(body.messages[1]?.content).toContain('recall_memories');
  });

  it('HTTP 非 200 → 抛错（runner 会把它记为该题失败）', async () => {
    const judge = createLlmJudge({
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch(() => ({ status: 429, body: { error: 'rate limited' } })),
    });
    await expect(
      judge.judge(evalCase, { kind: 'ok', data: null, maskedFields: [] }),
    ).rejects.toThrow('judge API 429');
  });

  it('响应缺 content → 抛错', async () => {
    const judge = createLlmJudge({
      baseUrl: 'https://x',
      apiKey: 'k',
      model: 'm',
      fetchImpl: fakeFetch(() => ({ body: { choices: [] } })),
    });
    await expect(
      judge.judge(evalCase, { kind: 'ok', data: null, maskedFields: [] }),
    ).rejects.toThrow('choices');
  });
});

describe('parseVerdict', () => {
  it('裸 JSON 与 markdown 代码栅栏都能解析', () => {
    expect(parseVerdict('{"pass": true, "rationale": "ok"}')).toEqual({
      pass: true,
      rationale: 'ok',
    });
    expect(parseVerdict('```json\n{"pass": false, "rationale": "泄漏"}\n```')).toEqual({
      pass: false,
      rationale: '泄漏',
    });
  });

  it('非 JSON / 缺字段 → 抛错，不猜', () => {
    expect(() => parseVerdict('我觉得可以通过')).toThrow('不是合法 JSON');
    expect(() => parseVerdict('{"pass": "yes"}')).toThrow();
  });
});

describe('judgeFromEnv', () => {
  it('三个变量齐全才返回 judge，缺一即 null', () => {
    const full = {
      JUDGE_BASE_URL: 'https://x',
      JUDGE_API_KEY: 'k',
      JUDGE_MODEL: 'm',
    };
    expect(judgeFromEnv(full)).not.toBeNull();
    expect(judgeFromEnv({ ...full, JUDGE_API_KEY: undefined })).toBeNull();
    expect(judgeFromEnv({})).toBeNull();
  });
});
