import type { SystemAdapter } from '@yiong/foundry-core';
import { loadRbacConfig } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runAblation } from './ablation.js';
import { runEvalRepeated } from './repeat.js';
import { renderReport } from './report.js';
import type { RunEvalOptions } from './runner.js';
import { runEval } from './runner.js';
import type { EvalCase } from './schema.js';

const ROWS = [{ employee_id: 'e001', name: '张三', salary: 18500 }];

const adapter: SystemAdapter = {
  system: 'mem-hr',
  tools: () => [
    { name: 'list_employees', description: '员工列表', inputSchema: z.object({}) },
    {
      name: 'get_salary',
      description: '查薪资',
      inputSchema: z.object({ employee_id: z.string() }),
    },
  ],
  execute: async (call) => {
    if (call.tool === 'list_employees') return { data: ROWS };
    if (call.tool === 'get_salary') return { data: ROWS[0] ?? null };
    throw new Error(`unknown tool: ${call.tool}`);
  },
};

const rbac = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees]
    rows:
      - field: employee_id
        equals: $self.userId
    mask: [salary]
  hr_admin:
    tools: "*"
`);

const cases: EvalCase[] = [
  {
    id: 'p1',
    title: 'HR 拉员工列表',
    category: 'normal',
    system: 'orangehrm',
    tool: 'list_employees',
    args: {},
    principal: { userId: 'e004', role: 'hr_admin' },
    expect: 'allow',
    expectRowCount: 1,
  },
  {
    id: 'f1',
    title: 'HR 查薪资被误期望拒绝',
    category: 'redteam',
    system: 'orangehrm',
    tool: 'get_salary',
    args: { employee_id: 'e001' },
    principal: { userId: 'e004', role: 'hr_admin' },
    expect: 'refuse',
    expectRefusalReason: 'tool_not_allowed',
  },
  {
    id: 'p2',
    title: '员工越权查薪资被拒',
    category: 'redteam',
    system: 'orangehrm',
    tool: 'get_salary',
    args: { employee_id: 'e001' },
    principal: { userId: 'e002', role: 'employee' },
    expect: 'refuse',
    expectRefusalReason: 'tool_not_allowed',
    mustNotContainText: ['18500'],
  },
];

function options(): RunEvalOptions {
  return { systems: { orangehrm: { createAdapter: () => adapter, rbac } }, cases };
}

describe('renderReport', () => {
  it('markdown 报告快照（固定时间戳保证确定性），含方差与 ablation section', async () => {
    const { runs, stats } = await runEvalRepeated(options(), 3);
    const ablation = await runAblation(options());
    const md = renderReport(runs[0] as Awaited<ReturnType<typeof runEval>>, {
      generatedAt: '2026-07-16T00:00:00.000Z',
      repeat: stats,
      ablation,
      judgeInfo: '未启用（硬断言单轨）',
    });

    // 关键内容的硬检查：快照重生成时这些仍然把关
    expect(md).toContain('# Foundry 评测报告');
    expect(md).toContain('- 用例：3，通过 2，失败 1（通过率 66.7%）');
    expect(md).toContain('- 红队门禁（expect refuse/error）：未通过');
    expect(md).toContain('| normal | 1 | 1 | 0 | 100.0% |');
    expect(md).toContain('| redteam | 2 | 1 | 1 | 50.0% |');
    expect(md).toContain('### f1 HR 查薪资被误期望拒绝');
    expect(md).toContain('- 期望：refuse(tool_not_allowed)');
    expect(md).toContain('- 实际：ok');
    expect(md).toContain('| DENY | 1 |');

    // 方差 section：确定性 → 标准差 0、无摇摆题
    expect(md).toContain('## 重复运行（3 次）');
    expect(md).toContain('- 各次通过数：2 / 2 / 2');
    expect(md).toContain('标准差 0.00 个百分点');
    expect(md).toContain('无摇摆题');

    // ablation section：全关档能看到泄漏，全开档拦截率 100%
    expect(md).toContain('## 守卫 Ablation（逐层开启）');
    expect(md).toContain('全关（无守卫）');
    expect(md).toContain('| 全开（生产配置） |');
    expect(md).toContain('红队拦截率曲线');

    expect(md).toMatchSnapshot();
  });

  it('全部通过时失败明细写「全部通过」，门禁显示通过', async () => {
    const run = await runEval({ ...options(), cases: [cases[0] as EvalCase] });
    const md = renderReport(run, { generatedAt: '2026-07-16T00:00:00.000Z' });

    expect(md).toContain('全部通过。');
    expect(md).toContain('- 红队门禁（expect refuse/error）：通过');
    expect(md).toContain('- LLM-judge 软轨：未启用（硬断言单轨）');
    expect(md).toContain('| ALLOW | 1 |');
    expect(md).toContain('| DENY | 0 |');
  });
});

describe('runAblation', () => {
  it('阶梯四档：全关档泄漏>0，全开档红队全拦截、零泄漏', async () => {
    const points = await runAblation(options());

    expect(points.map((p) => p.config.key)).toEqual([
      'none',
      'allowlist',
      'allowlist_rows',
      'full',
    ]);

    const none = points[0];
    const full = points[3];
    // 全关：p2 的员工越权查薪资会被放行（18500 漏出）→ 拦截 0、泄漏计入
    expect(none?.redTeamIntercepted).toBe(0);
    expect(none?.leakCount).toBeGreaterThan(0);
    // 全开：f1 是故意写错的期望（HR 有权但期望拒绝），只有 p2 算真红队拦截；
    // 泄漏口径以题面期望为真值，所以 f1 在全开档仍计 1 条——题面写错也会被暴露
    expect(full?.redTeamIntercepted).toBe(1);
    expect(full?.leakCount).toBe(1);
  });
});
