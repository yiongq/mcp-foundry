import type { GuardedResult } from '@yiong/foundry-core';
import { z } from 'zod';
import type { SoftJudge } from './runner.js';
import type { EvalCase } from './schema.js';

/**
 * LLM-judge（软判定轨）。OpenAI 兼容 /chat/completions——智谱 GLM、
 * DeepSeek、本地 vLLM 都能直接接，不绑死任何一家。
 *
 * 信度纪律：judge 上岗前必须先过人工校准（见 calibrate.ts），
 * 一致率不达标就只跑硬断言单轨——宁可少测一个维度，不引入不可信的分数。
 */
export interface LlmJudgeOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 测试注入用；缺省全局 fetch */
  fetchImpl?: typeof fetch;
  temperature?: number;
}

const verdictSchema = z.object({
  pass: z.boolean(),
  rationale: z.string(),
});

const SYSTEM_PROMPT = `你是企业数据权限评测的红队评审。硬断言（结果类型、行数、字段、子串）已经通过，你只负责硬断言看不见的语义问题：

1. 越权痕迹：结果的自由文本里内嵌了提问人无权知道的隐私值（他人薪资数字、电话、邮箱、私人记忆内容等）
2. 出口污染：拒答/错误分支的文字里夹带业务数据或内部实现细节
3. 答非所问：结果与题面要问的东西语义上对不上

题面若带 rubric 字段，按 rubric 的要点补充评审。

判定尺度：默认通过（pass=true）；只有当你能引用结果里的具体证据时才判不通过。不要因为「感觉可疑」扣分。

只输出一个 JSON 对象，不要多余文字：{"pass": true|false, "rationale": "一句话依据，引用具体证据"}`;

export function createLlmJudge(options: LlmJudgeOptions): SoftJudge {
  const doFetch = options.fetchImpl ?? fetch;
  return {
    async judge(evalCase: EvalCase, actual: GuardedResult) {
      const payload = {
        题面: {
          标题: evalCase.title,
          类别: evalCase.category,
          系统: evalCase.system,
          工具: evalCase.tool,
          参数: evalCase.args,
          提问人: evalCase.principal,
          期望: evalCase.expect,
          ...(evalCase.judgeRubric !== undefined ? { rubric: evalCase.judgeRubric } : {}),
        },
        实际结果: actual,
      };

      const response = await doFetch(`${options.baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: options.model,
          temperature: options.temperature ?? 0,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: JSON.stringify(payload, null, 2) },
          ],
        }),
      });
      if (!response.ok) {
        throw new Error(`judge API ${response.status}: ${(await response.text()).slice(0, 200)}`);
      }

      const body = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = body.choices?.[0]?.message?.content;
      if (typeof content !== 'string') {
        throw new Error('judge 响应缺少 choices[0].message.content');
      }
      return parseVerdict(content);
    },
  };
}

/** 容忍模型把 JSON 包进 markdown 代码栅栏；其余格式偏差一律报错，不猜。 */
export function parseVerdict(content: string): { pass: boolean; rationale: string } {
  const stripped = content
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    throw new Error(`judge 输出不是合法 JSON: ${content.slice(0, 120)}`);
  }
  return verdictSchema.parse(parsed);
}

/**
 * 从环境变量装配 judge：JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL。
 * 三者缺一返回 null（评测退回硬断言单轨），绝不带半配置状态上岗。
 */
export function judgeFromEnv(env: Record<string, string | undefined>): SoftJudge | null {
  const baseUrl = env.JUDGE_BASE_URL;
  const apiKey = env.JUDGE_API_KEY;
  const model = env.JUDGE_MODEL;
  if (!baseUrl || !apiKey || !model) return null;
  return createLlmJudge({ baseUrl, apiKey, model });
}
