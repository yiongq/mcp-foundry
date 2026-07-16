import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGolden, renderCalibrationReport, runCalibration } from './calibrate.js';
import { judgeFromEnv } from './judge.js';

// 用法：JUDGE_BASE_URL=… JUDGE_API_KEY=… JUDGE_MODEL=… \
//   node --import tsx src/calibrate-cli.ts [--golden <yaml>] [--out <md>]
// judge 对人工标注 golden 集打分，一致率 <90% 退出码 1——没过校准的 judge 不许上岗。

const here = dirname(fileURLToPath(import.meta.url));

function flagValue(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`参数 --${name} 缺少值`);
  return value;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const goldenPath = resolve(
    flagValue(argv, 'golden') ?? resolve(here, '../calibration/golden.yaml'),
  );
  const outPath = resolve(flagValue(argv, 'out') ?? 'eval-reports/calibration.md');

  const judge = judgeFromEnv(process.env);
  if (judge === null) {
    throw new Error('校准需要 JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL 环境变量');
  }

  const items = loadGolden(await readFile(goldenPath, 'utf8'));
  console.log(`校准开始：${items.length} 条 golden 标注，judge = ${process.env.JUDGE_MODEL}`);

  const result = await runCalibration(judge, items);

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    renderCalibrationReport(result, {
      judgeInfo: `${process.env.JUDGE_MODEL} @ ${process.env.JUDGE_BASE_URL}`,
    }),
    'utf8',
  );

  console.log(
    `一致率 ${result.agreements}/${result.total}（${(result.agreementRate * 100).toFixed(1)}%），` +
      `漏报（人工 fail、judge pass）${result.confusion.humanFailJudgePass} 条，报告已写入 ${outPath}`,
  );
  if (!result.passed) {
    console.error('校准未过线（<90%）：judge 不许上岗，评测请继续跑硬断言单轨');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
