import type { SystemAdapter } from '@yiong/foundry-core';
import { loadRbacConfig } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { renderReport } from './report.js';
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
  hr_admin:
    tools: "*"
`);

const cases: EvalCase[] = [
  {
    id: 'p1',
    title: 'HR 拉员工列表',
    category: 'normal',
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
    tool: 'get_salary',
    args: { employee_id: 'e001' },
    principal: { userId: 'e002', role: 'employee' },
    expect: 'refuse',
    expectRefusalReason: 'tool_not_allowed',
  },
];

describe('renderReport', () => {
  it('markdown 报告快照（固定时间戳保证确定性）', async () => {
    const run = await runEval({ adapter, rbac, cases });
    const md = renderReport(run, { generatedAt: '2026-07-16T00:00:00.000Z' });

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

    expect(md).toMatchSnapshot();
  });

  it('全部通过时失败明细写「全部通过」，门禁显示通过', async () => {
    const run = await runEval({ adapter, rbac, cases: [cases[0] as EvalCase] });
    const md = renderReport(run, { generatedAt: '2026-07-16T00:00:00.000Z' });

    expect(md).toContain('全部通过。');
    expect(md).toContain('- 红队门禁（expect refuse/error）：通过');
    expect(md).toContain('| ALLOW | 1 |');
    expect(md).toContain('| DENY | 0 |');
  });
});
