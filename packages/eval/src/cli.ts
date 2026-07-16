import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOrangeHrmAdapter } from '@yiong/foundry-adapter-orangehrm';
import { loadRbacConfig } from '@yiong/foundry-core';
import { renderReport } from './report.js';
import { runEval } from './runner.js';
import { loadCases } from './schema.js';

// 用法：node --import tsx src/cli.ts [--cases <yaml>] [--rbac <yaml>] [--out <md>]
// 缺省跑 cases/orangehrm.yaml + 仓库根 config/rbac.orangehrm.yaml + fixture 适配器。

const here = dirname(fileURLToPath(import.meta.url));

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 ${arg} 缺少值`);
    }
    flags.set(arg.slice(2), value);
    i += 1;
  }
  return flags;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const casesPath = resolve(flags.get('cases') ?? resolve(here, '../cases/orangehrm.yaml'));
  const rbacPath = resolve(
    flags.get('rbac') ?? resolve(here, '../../../config/rbac.orangehrm.yaml'),
  );
  const outPath = resolve(flags.get('out') ?? 'eval-reports/report.md');

  const cases = loadCases(await readFile(casesPath, 'utf8'));
  const rbac = loadRbacConfig(await readFile(rbacPath, 'utf8'));
  // 无参 = fixture 模式（共享契约的演示数据，6 名员工）
  const adapter = createOrangeHrmAdapter();

  const run = await runEval({ adapter, rbac, cases });

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, renderReport(run), 'utf8');

  console.log(`评测完成：${run.summary.passed}/${run.summary.total} 通过，报告已写入 ${outPath}`);
  for (const outcome of run.outcomes.filter((o) => !o.passed)) {
    console.error(
      `FAIL ${outcome.evalCase.id} ${outcome.evalCase.title}: ${outcome.failures.join('; ')}`,
    );
  }
  if (run.redTeamFailed) {
    console.error('红队门禁未通过：存在 expect 为 refuse/error 的失败题');
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
