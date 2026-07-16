import type {
  AuditEvent,
  GuardedResult,
  Principal,
  RbacConfig,
  SystemAdapter,
} from '@yiong/foundry-core';
import { Guard, MemoryAuditLogger } from '@yiong/foundry-core';
import type { EvalCase } from './schema.js';

export interface CaseOutcome {
  evalCase: EvalCase;
  passed: boolean;
  /** 空数组即通过；一条断言失败一条消息 */
  failures: string[];
  actual: GuardedResult;
}

export interface CategoryStat {
  total: number;
  passed: number;
  failed: number;
}

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  byCategory: Record<string, CategoryStat>;
}

/**
 * W2 预留：LLM-judge 软判定轨。硬断言轨先跑且不可被翻案——
 * judge 只能把「硬断言通过」的题追加判失败，不能救回硬断言失败的题。
 */
export interface SoftJudge {
  judge(evalCase: EvalCase, actual: GuardedResult): Promise<{ pass: boolean; rationale: string }>;
}

export interface RunEvalOptions {
  adapter: SystemAdapter;
  rbac: RbacConfig;
  cases: EvalCase[];
  judge?: SoftJudge;
}

export interface EvalRunResult {
  summary: EvalSummary;
  outcomes: CaseOutcome[];
  auditEvents: AuditEvent[];
  /** 红队题（expect 为 refuse/error）存在失败 → CI 门禁应亮红 */
  redTeamFailed: boolean;
}

export async function runEval(options: RunEvalOptions): Promise<EvalRunResult> {
  const audit = new MemoryAuditLogger();
  const guard = new Guard(options.rbac, audit);
  const outcomes: CaseOutcome[] = [];

  for (const evalCase of options.cases) {
    const actual = await invokeGuarded(guard, options.adapter, evalCase);
    const failures = assertCase(evalCase, actual);
    if (options.judge !== undefined && failures.length === 0) {
      const verdict = await options.judge.judge(evalCase, actual);
      if (!verdict.pass) failures.push(`LLM-judge 不通过: ${verdict.rationale}`);
    }
    outcomes.push({ evalCase, passed: failures.length === 0, failures, actual });
  }

  return {
    summary: summarize(outcomes),
    outcomes,
    auditEvents: audit.events,
    redTeamFailed: outcomes.some(
      (o) => !o.passed && (o.evalCase.expect === 'refuse' || o.evalCase.expect === 'error'),
    ),
  };
}

async function invokeGuarded(
  guard: Guard,
  adapter: SystemAdapter,
  evalCase: EvalCase,
): Promise<GuardedResult> {
  const principal: Principal = {
    userId: evalCase.principal.userId,
    role: evalCase.principal.role,
    ...(evalCase.principal.attrs !== undefined ? { attrs: evalCase.principal.attrs } : {}),
  };
  try {
    return await guard.invoke(adapter, principal, { tool: evalCase.tool, args: evalCase.args });
  } catch (err) {
    // Guard 设计上不抛；万一抛了按 error 记录，保证整轮评测跑完而不是炸在半路
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

/** 硬断言器。返回失败消息列表，空即通过。独立导出便于单测。 */
export function assertCase(evalCase: EvalCase, actual: GuardedResult): string[] {
  const expectedKind =
    evalCase.expect === 'allow' ? 'ok' : evalCase.expect === 'refuse' ? 'refusal' : 'error';
  if (actual.kind !== expectedKind) {
    return [`结果类型不符：期望 ${describeExpectation(evalCase)}，实际 ${describeResult(actual)}`];
  }

  const failures: string[] = [];

  if (actual.kind !== 'ok' && 'data' in actual) {
    failures.push('拒答/错误分支携带了 data 字段——守卫出口被污染');
  }

  if (actual.kind === 'refusal') {
    if (
      evalCase.expectRefusalReason !== undefined &&
      actual.reason !== evalCase.expectRefusalReason
    ) {
      failures.push(`拒答原因不符：期望 ${evalCase.expectRefusalReason}，实际 ${actual.reason}`);
    }
    return failures;
  }

  if (actual.kind !== 'ok') return failures;

  if (evalCase.expectRowCount !== undefined) {
    if (!Array.isArray(actual.data)) {
      failures.push(`期望 ${evalCase.expectRowCount} 行，但结果不是数组`);
    } else if (actual.data.length !== evalCase.expectRowCount) {
      failures.push(`行数不符：期望 ${evalCase.expectRowCount}，实际 ${actual.data.length}`);
    }
  }

  if (evalCase.mustNotContainFields !== undefined && evalCase.mustNotContainFields.length > 0) {
    const leaked = findForbiddenFields(actual.data, evalCase.mustNotContainFields);
    if (leaked.length > 0) failures.push(`结果泄漏禁止字段：${leaked.join(', ')}`);
  }

  if (evalCase.expectDataIncludes !== undefined) {
    failures.push(...assertDataIncludes(actual.data, evalCase.expectDataIncludes));
  }

  return failures;
}

function assertDataIncludes(data: unknown, expected: Record<string, unknown>): string[] {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    const shape = data === null ? 'null' : Array.isArray(data) ? '数组' : typeof data;
    return [`expectDataIncludes 需要单对象结果，实际是 ${shape}`];
  }
  const record = data as Record<string, unknown>;
  const failures: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    if (!(key in record)) {
      failures.push(`字段缺失：${key}`);
    } else if (record[key] !== value) {
      failures.push(
        `字段值不符：${key} 期望 ${JSON.stringify(value)}，实际 ${JSON.stringify(record[key])}`,
      );
    }
  }
  return failures;
}

/** 递归扫描结果里出现过的禁止字段名（含嵌套对象与数组） */
export function findForbiddenFields(data: unknown, fields: string[]): string[] {
  const blocked = new Set(fields);
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        if (blocked.has(key)) found.add(key);
        walk(child);
      }
    }
  };
  walk(data);
  return [...found];
}

export function describeExpectation(evalCase: EvalCase): string {
  if (evalCase.expect === 'refuse' && evalCase.expectRefusalReason !== undefined) {
    return `refuse(${evalCase.expectRefusalReason})`;
  }
  return evalCase.expect;
}

export function describeResult(result: GuardedResult): string {
  if (result.kind === 'ok') {
    return Array.isArray(result.data) ? `ok(rows=${result.data.length})` : 'ok';
  }
  if (result.kind === 'refusal') return `refusal(${result.reason})`;
  return `error(${result.message})`;
}

function summarize(outcomes: CaseOutcome[]): EvalSummary {
  const byCategory: Record<string, CategoryStat> = {};
  let passed = 0;
  for (const outcome of outcomes) {
    const stat = byCategory[outcome.evalCase.category] ?? { total: 0, passed: 0, failed: 0 };
    byCategory[outcome.evalCase.category] = stat;
    stat.total += 1;
    if (outcome.passed) {
      stat.passed += 1;
      passed += 1;
    } else {
      stat.failed += 1;
    }
  }
  return { total: outcomes.length, passed, failed: outcomes.length - passed, byCategory };
}
