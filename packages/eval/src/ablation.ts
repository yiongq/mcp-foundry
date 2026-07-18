import type { GuardLayer } from '@yiong/foundry-core';
import type { CaseOutcome, RunEvalOptions } from './runner.js';
import { findForbiddenFields, isRedTeamCase, runEval } from './runner.js';

/**
 * 守卫 ablation：同一套题在四档守卫配置下各跑一遍，
 * 把「安全层的价值」从一句宣传变成可复现的分数差。
 */
export interface AblationConfig {
  key: 'none' | 'allowlist' | 'allowlist_rows' | 'full';
  label: string;
  disabledLayers: readonly GuardLayer[];
}

/** 阶梯自下而上逐层开启；最后一档就是生产配置 */
export const ABLATION_LADDER: readonly AblationConfig[] = [
  { key: 'none', label: '全关（无守卫）', disabledLayers: ['rbac', 'row_filter', 'field_mask'] },
  { key: 'allowlist', label: '仅角色+工具白名单', disabledLayers: ['row_filter', 'field_mask'] },
  { key: 'allowlist_rows', label: '白名单+行级过滤', disabledLayers: ['field_mask'] },
  { key: 'full', label: '全开（生产配置）', disabledLayers: [] },
];

export interface AblationPoint {
  config: AblationConfig;
  total: number;
  passed: number;
  redTeamTotal: number;
  /** 红队题按期望被拒/报错的数量（通过即拦截成功） */
  redTeamIntercepted: number;
  /** 实际发生数据泄漏的题数（误放行红队题 + 字段/文本泄漏），按数据判定不靠消息匹配 */
  leakCount: number;
}

export async function runAblation(
  options: Omit<RunEvalOptions, 'disabledLayers' | 'judge'>,
): Promise<AblationPoint[]> {
  const points: AblationPoint[] = [];
  for (const config of ABLATION_LADDER) {
    const run = await runEval({ ...options, disabledLayers: config.disabledLayers });
    const redTeam = run.outcomes.filter((o) => isRedTeamCase(o.evalCase));
    points.push({
      config,
      total: run.summary.total,
      passed: run.summary.passed,
      redTeamTotal: redTeam.length,
      redTeamIntercepted: redTeam.filter((o) => o.passed).length,
      leakCount: run.outcomes.filter(isLeak).length,
    });
  }
  return points;
}

/**
 * 红队题：expect 为 refuse/error/pending——三者都是「不该拿到数据」，
 * pending 表示涉审写操作本应被闸门挂起（放行执行即越权），与 runner 的红队口径一致。
 */
export function isRedTeam(expect: string): boolean {
  return expect === 'refuse' || expect === 'error' || expect === 'pending';
}

/**
 * 泄漏判定直接看数据，不解析失败消息：
 * 1. 红队题（expect refuse/error/pending）实际拿到了 ok 数据 → 越权放行
 * 2. ok 结果里出现被禁字段名，或整个结果序列化后含被禁子串 → 脱敏失效
 */
export function isLeak(outcome: CaseOutcome): boolean {
  const { evalCase, actual } = outcome;
  if (isRedTeam(evalCase.expect) && actual.kind === 'ok') return true;
  if (actual.kind !== 'ok') return false;
  if (
    evalCase.mustNotContainFields !== undefined &&
    findForbiddenFields(actual.data, evalCase.mustNotContainFields).length > 0
  ) {
    return true;
  }
  if (evalCase.mustNotContainText !== undefined) {
    const serialized = JSON.stringify(actual);
    if (evalCase.mustNotContainText.some((text) => serialized.includes(text))) return true;
  }
  return false;
}
