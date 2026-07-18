import type { AblationPoint } from './ablation.js';
import type { RepeatStats } from './repeat.js';
import type { EvalRunResult } from './runner.js';
import { describeExpectation, describeResult } from './runner.js';

export interface RenderReportOptions {
  /** 固定时间戳便于快照测试；缺省取当前时间 */
  generatedAt?: string;
  /** judge 状态说明；缺省视为未启用 */
  judgeInfo?: string;
  /** ≥2 次重复跑时渲染方差 section */
  repeat?: RepeatStats;
  /** ablation 阶梯结果（全开档之外的三档只进这一节，不影响门禁） */
  ablation?: readonly AblationPoint[];
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
  lines.push(
    `- 红队门禁（类别 redteam 或 expect refuse/error/pending）：${run.redTeamFailed ? '未通过' : '通过'}`,
  );
  lines.push(`- LLM-judge 软轨：${options.judgeInfo ?? '未启用（硬断言单轨）'}`);
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

  if (options.repeat !== undefined && options.repeat.runs > 1) {
    lines.push(...renderRepeatSection(options.repeat));
  }

  if (options.ablation !== undefined && options.ablation.length > 0) {
    lines.push(...renderAblationSection(options.ablation));
  }

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
  const counts = { ALLOW: 0, DENY: 0, PENDING: 0, ERROR: 0 };
  for (const event of run.auditEvents) counts[event.decision] += 1;
  lines.push('| 决策 | 条数 |');
  lines.push('| --- | ---: |');
  lines.push(`| ALLOW | ${counts.ALLOW} |`);
  lines.push(`| DENY | ${counts.DENY} |`);
  lines.push(`| PENDING | ${counts.PENDING} |`);
  lines.push(`| ERROR | ${counts.ERROR} |`);

  return `${lines.join('\n')}\n`;
}

/** 方差不是走过场：硬断言轨报 0 证明确定性，接入 judge 后 >0 立刻暴露不稳定题。 */
function renderRepeatSection(stats: RepeatStats): string[] {
  const lines: string[] = [];
  lines.push(`## 重复运行（${stats.runs} 次）`);
  lines.push('');
  lines.push(`- 各次通过数：${stats.passCounts.join(' / ')}`);
  lines.push(
    `- 通过率均值 ${(stats.meanPassRate * 100).toFixed(1)}%，` +
      `标准差 ${(stats.stddevPassRate * 100).toFixed(2)} 个百分点`,
  );
  if (stats.flakyCaseIds.length === 0) {
    lines.push('- 无摇摆题：全部用例每次结果一致');
  } else {
    lines.push(`- **摇摆题（各次结果不一致）**：${stats.flakyCaseIds.join(', ')}`);
  }
  lines.push('');
  return lines;
}

/** 守卫逐层开启的分数阶梯——安全层的价值以分数差呈现，而不是一句口号。 */
function renderAblationSection(points: readonly AblationPoint[]): string[] {
  const lines: string[] = [];
  lines.push('## 守卫 Ablation（逐层开启）');
  lines.push('');
  // 头条指标：把「安全靠架构不靠提示词」变成一个可复现的数字对比。
  const none = points.find((p) => p.config.key === 'none');
  const full = points.find((p) => p.config.key === 'full');
  if (none !== undefined && full !== undefined) {
    lines.push(
      `**红队攻击得手率：无守卫 ${attackSuccess(none)}（${none.leakCount} 题泄漏）` +
        ` → 生产配置 ${attackSuccess(full)}（${full.leakCount} 题泄漏）。** ` +
        '越权数据在守卫出口不存在，靠的是执行层拦截，不是提示词求 agent 别说。',
    );
    lines.push('');
  }
  lines.push('| 守卫配置 | 通过率 | 红队拦截率 | 攻击得手率 | 泄漏题数 |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const p of points) {
    lines.push(
      `| ${p.config.label} | ${rate(p.passed, p.total)} ` +
        `| ${rate(p.redTeamIntercepted, p.redTeamTotal)} ` +
        `| ${attackSuccess(p)} | ${p.leakCount} |`,
    );
  }
  lines.push('');
  lines.push('红队拦截率曲线：');
  lines.push('');
  lines.push('```');
  const labelWidth = Math.max(...points.map((p) => p.config.label.length));
  for (const p of points) {
    const ratio = p.redTeamTotal === 0 ? 0 : p.redTeamIntercepted / p.redTeamTotal;
    const bar = '█'.repeat(Math.round(ratio * 20)).padEnd(20, '·');
    const label = p.config.label.padEnd(labelWidth, '　');
    lines.push(`${label} ${bar} ${(ratio * 100).toFixed(0).padStart(3)}%`);
  }
  lines.push('```');
  lines.push('');
  return lines;
}

function rate(passed: number, total: number): string {
  if (total === 0) return 'n/a';
  return `${((passed / total) * 100).toFixed(1)}%`;
}

/** 攻击得手率 = 未被拦截的红队题占比（红队拦截率的镜像），生产配置下应为 0.0% */
function attackSuccess(p: AblationPoint): string {
  return rate(p.redTeamTotal - p.redTeamIntercepted, p.redTeamTotal);
}
