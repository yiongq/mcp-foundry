import type { EvalRunResult } from './runner.js';
import { describeExpectation, describeResult } from './runner.js';

export interface RenderReportOptions {
  /** 固定时间戳便于快照测试；缺省取当前时间 */
  generatedAt?: string;
}

export function renderReport(run: EvalRunResult, options: RenderReportOptions = {}): string {
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const { summary } = run;
  const lines: string[] = [];

  lines.push('# Foundry 评测报告');
  lines.push('');
  lines.push(`- 生成时间：${generatedAt}`);
  lines.push(
    `- 用例：${summary.total}，通过 ${summary.passed}，失败 ${summary.failed}` +
      `（通过率 ${rate(summary.passed, summary.total)}）`,
  );
  lines.push(`- 红队门禁（expect refuse/error）：${run.redTeamFailed ? '未通过' : '通过'}`);
  lines.push('');

  lines.push('## 分类总览');
  lines.push('');
  lines.push('| 类别 | 用例数 | 通过 | 失败 | 通过率 |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const [category, stat] of Object.entries(summary.byCategory)) {
    lines.push(
      `| ${category} | ${stat.total} | ${stat.passed} | ${stat.failed} ` +
        `| ${rate(stat.passed, stat.total)} |`,
    );
  }
  lines.push('');

  lines.push('## 失败明细');
  lines.push('');
  const failedOutcomes = run.outcomes.filter((o) => !o.passed);
  if (failedOutcomes.length === 0) {
    lines.push('全部通过。');
    lines.push('');
  } else {
    for (const outcome of failedOutcomes) {
      lines.push(`### ${outcome.evalCase.id} ${outcome.evalCase.title}`);
      lines.push('');
      lines.push(`- 期望：${describeExpectation(outcome.evalCase)}`);
      lines.push(`- 实际：${describeResult(outcome.actual)}`);
      for (const failure of outcome.failures) lines.push(`- 断言：${failure}`);
      lines.push('');
    }
  }

  lines.push('## 审计摘要');
  lines.push('');
  const counts = { ALLOW: 0, DENY: 0, ERROR: 0 };
  for (const event of run.auditEvents) counts[event.decision] += 1;
  lines.push('| 决策 | 条数 |');
  lines.push('| --- | ---: |');
  lines.push(`| ALLOW | ${counts.ALLOW} |`);
  lines.push(`| DENY | ${counts.DENY} |`);
  lines.push(`| ERROR | ${counts.ERROR} |`);

  return `${lines.join('\n')}\n`;
}

function rate(passed: number, total: number): string {
  if (total === 0) return 'n/a';
  return `${((passed / total) * 100).toFixed(1)}%`;
}
