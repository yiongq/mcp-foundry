import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { GuardedResult } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { loadGolden, renderCalibrationReport, runCalibration } from './calibrate.js';
import type { SoftJudge } from './runner.js';
import type { EvalCase } from './schema.js';

const goldenPath = resolve(import.meta.dirname, '../calibration/golden.yaml');

describe('golden 校准集', () => {
  it('能被 schema 解析，pass/fail 双向陷阱都有', async () => {
    const items = loadGolden(await readFile(goldenPath, 'utf8'));

    expect(items.length).toBeGreaterThanOrEqual(10);
    const passCount = items.filter((i) => i.human === 'pass').length;
    const failCount = items.filter((i) => i.human === 'fail').length;
    // 两类都得有足够样本，否则校准测不出误报/漏报某一侧
    expect(passCount).toBeGreaterThanOrEqual(4);
    expect(failCount).toBeGreaterThanOrEqual(4);
    // id 唯一
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });
});

/** 用「人工标注抄答案」的完美 judge 和固定翻车的 judge 验证统计口径 */
function perfectJudgeFor(labels: Map<string, boolean>): SoftJudge {
  return {
    judge: async (c: EvalCase) => ({
      pass: labels.get(c.id) ?? true,
      rationale: 'echo',
    }),
  };
}

describe('runCalibration', () => {
  it('完美 judge：一致率 100%，校准通过，混淆矩阵无危险格', async () => {
    const items = loadGolden(await readFile(goldenPath, 'utf8'));
    const labels = new Map(items.map((i) => [i.case.id, i.human === 'pass'] as const));

    const result = await runCalibration(perfectJudgeFor(labels), items);

    expect(result.agreementRate).toBe(1);
    expect(result.passed).toBe(true);
    expect(result.confusion.humanFailJudgePass).toBe(0);
    expect(result.confusion.humanPassJudgeFail).toBe(0);
  });

  it('全部判 pass 的偷懒 judge：漏报全进 humanFailJudgePass，校准不通过', async () => {
    const items = loadGolden(await readFile(goldenPath, 'utf8'));
    const lazy: SoftJudge = { judge: async () => ({ pass: true, rationale: '都行' }) };

    const result = await runCalibration(lazy, items);

    const failCount = items.filter((i) => i.human === 'fail').length;
    expect(result.confusion.humanFailJudgePass).toBe(failCount);
    expect(result.passed).toBe(false);
  });

  it('judge 抛错按不一致记，报告里能看到调用失败', async () => {
    const items = loadGolden(await readFile(goldenPath, 'utf8'));
    const broken: SoftJudge = {
      judge: async () => {
        throw new Error('ETIMEDOUT');
      },
    };

    const result = await runCalibration(broken, items.slice(0, 2));

    expect(result.agreements).toBe(0);
    const md = renderCalibrationReport(result, { generatedAt: '2026-07-16T00:00:00.000Z' });
    expect(md).toContain('judge 调用失败：ETIMEDOUT');
    expect(md).toContain('未过线');
  });

  it('报告包含混淆矩阵与分歧明细', async () => {
    const items = loadGolden(await readFile(goldenPath, 'utf8'));
    const labels = new Map(items.map((i) => [i.case.id, i.human === 'pass'] as const));
    // 人工 fail 的第一题被 judge 误放
    const firstFail = items.find((i) => i.human === 'fail');
    if (firstFail) labels.set(firstFail.case.id, true);

    const result = await runCalibration(perfectJudgeFor(labels), items);
    const md = renderCalibrationReport(result, {
      generatedAt: '2026-07-16T00:00:00.000Z',
      judgeInfo: 'mock',
    });

    expect(md).toContain('混淆矩阵');
    expect(md).toContain('漏报，最危险');
    if (firstFail) expect(md).toContain(firstFail.id);
  });
});

// GuardedResult 类型兼容性静态检查：golden 里的 actual 能喂给 SoftJudge
const _typeCheck: GuardedResult = { kind: 'ok', data: null, maskedFields: [] };
void _typeCheck;
