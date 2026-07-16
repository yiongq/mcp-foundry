import type { EvalRunResult, RunEvalOptions } from './runner.js';
import { runEval } from './runner.js';

/**
 * 重复跑方差统计。硬断言轨是确定性的，标准差应为 0——报出来不是走过场，
 * 是把「确定性」变成可核查的数字；接入 LLM-judge 后方差>0 时能立刻暴露。
 */
export interface RepeatStats {
  runs: number;
  passCounts: number[];
  /** 0~1 */
  meanPassRate: number;
  /** 总体标准差（对 0~1 的通过率） */
  stddevPassRate: number;
  /** 各次通过/失败不一致的题 id——非确定性的直接证据 */
  flakyCaseIds: string[];
}

export interface RepeatedEvalResult {
  runs: EvalRunResult[];
  stats: RepeatStats;
}

export async function runEvalRepeated(
  options: RunEvalOptions,
  times: number,
): Promise<RepeatedEvalResult> {
  if (!Number.isInteger(times) || times < 1) {
    throw new Error(`重复次数必须是 ≥1 的整数，收到 ${times}`);
  }
  const runs: EvalRunResult[] = [];
  for (let i = 0; i < times; i += 1) {
    runs.push(await runEval(options));
  }
  return { runs, stats: computeRepeatStats(runs) };
}

export function computeRepeatStats(runs: EvalRunResult[]): RepeatStats {
  if (runs.length === 0) throw new Error('至少需要一次运行才能统计');

  const passCounts = runs.map((r) => r.summary.passed);
  const rates = runs.map((r) => (r.summary.total === 0 ? 0 : r.summary.passed / r.summary.total));
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const variance = rates.reduce((acc, r) => acc + (r - mean) ** 2, 0) / rates.length;

  const verdictsByCase = new Map<string, boolean[]>();
  for (const run of runs) {
    for (const outcome of run.outcomes) {
      const list = verdictsByCase.get(outcome.evalCase.id) ?? [];
      list.push(outcome.passed);
      verdictsByCase.set(outcome.evalCase.id, list);
    }
  }
  const flakyCaseIds = [...verdictsByCase.entries()]
    .filter(([, verdicts]) => verdicts.some((v) => v !== verdicts[0]))
    .map(([id]) => id);

  return {
    runs: runs.length,
    passCounts,
    meanPassRate: mean,
    stddevPassRate: Math.sqrt(variance),
    flakyCaseIds,
  };
}
