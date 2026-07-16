import type { SystemAdapter } from '@yiong/foundry-core';
import { loadRbacConfig } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { computeRepeatStats, runEvalRepeated } from './repeat.js';
import type { EvalCase } from './schema.js';

const echo: SystemAdapter = {
  system: 'echo',
  tools: () => [{ name: 'ping', description: 'ping', inputSchema: z.object({}) }],
  execute: async () => ({ data: { ok: true } }),
};

const rbac = loadRbacConfig(`
roles:
  employee:
    tools: [ping]
`);

const pingCase: EvalCase = {
  id: 'p1',
  title: 'ping',
  category: 'normal',
  system: 'echo',
  tool: 'ping',
  args: {},
  principal: { userId: 'e001', role: 'employee' },
  expect: 'allow',
};

describe('runEvalRepeated', () => {
  it('确定性硬断言轨：3 次重复方差为 0，无 flaky 题', async () => {
    const { runs, stats } = await runEvalRepeated(
      { systems: { echo: { createAdapter: () => echo, rbac } }, cases: [pingCase] },
      3,
    );

    expect(runs).toHaveLength(3);
    expect(stats.passCounts).toEqual([1, 1, 1]);
    expect(stats.meanPassRate).toBe(1);
    expect(stats.stddevPassRate).toBe(0);
    expect(stats.flakyCaseIds).toEqual([]);
  });

  it('非确定性 judge：各次结果不一致时能点名 flaky 题、方差>0', async () => {
    let call = 0;
    const flipJudge = {
      judge: async () => {
        call += 1;
        return { pass: call % 2 === 1, rationale: '摇摆' };
      },
    };
    const { stats } = await runEvalRepeated(
      {
        systems: { echo: { createAdapter: () => echo, rbac } },
        cases: [pingCase],
        judge: flipJudge,
      },
      2,
    );

    expect(stats.flakyCaseIds).toEqual(['p1']);
    expect(stats.stddevPassRate).toBeGreaterThan(0);
  });

  it('非法重复次数抛错', async () => {
    await expect(runEvalRepeated({ systems: {}, cases: [] }, 0)).rejects.toThrow(/重复次数/);
  });
});

describe('computeRepeatStats', () => {
  it('空运行列表抛错', () => {
    expect(() => computeRepeatStats([])).toThrow();
  });
});
