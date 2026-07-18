import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createEspoCrmAdapter,
  mysqlConfigFromEnv as espoMysqlConfigFromEnv,
  MySqlEspoCrmBackend,
} from '@yiong/foundry-adapter-espocrm';
import { createMemoryAdapter, MemoryStore } from '@yiong/foundry-adapter-memory';
import {
  createOrangeHrmAdapter,
  MySqlOrangeHrmBackend,
  mysqlConfigFromEnv,
} from '@yiong/foundry-adapter-orangehrm';
import { loadRbacConfig } from '@yiong/foundry-core';
import { runAblation } from './ablation.js';
import { judgeFromEnv } from './judge.js';
import { runEvalRepeated } from './repeat.js';
import { renderReport } from './report.js';
import type { EvalSystem } from './runner.js';
import type { EvalCase } from './schema.js';
import { loadCases } from './schema.js';

// 用法：node --import tsx src/cli.ts
//   [--cases <yaml 文件或目录>]  缺省 cases/ 目录（全部 *.yaml 合并跑）
//   [--config-dir <dir>]        缺省仓库根 config/（rbac.orangehrm.yaml + rbac.espocrm.yaml + rbac.memory.yaml）
//   [--out <md>]                缺省 eval-reports/report.md
//   [--repeat <n>]              重复跑 n 次并报方差（硬断言轨应为 0）
//   [--ablation]                追加守卫逐层开/关的四档对照
//   [--judge]                   启用 LLM-judge 软轨（需 JUDGE_BASE_URL/JUDGE_API_KEY/JUDGE_MODEL）
// 红队门禁：任何一次全开跑里 expect refuse/error/pending 的题失败 → 退出码 1。
// ablation 档位的失败是实验数据，不进门禁。

const here = dirname(fileURLToPath(import.meta.url));

interface Flags {
  values: Map<string, string>;
  switches: Set<string>;
}

const VALUE_FLAGS = new Set(['cases', 'config-dir', 'out', 'repeat']);
const SWITCH_FLAGS = new Set(['ablation', 'judge']);

function parseFlags(argv: string[]): Flags {
  const values = new Map<string, string>();
  const switches = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined || !arg.startsWith('--')) continue;
    const name = arg.slice(2);
    if (SWITCH_FLAGS.has(name)) {
      switches.add(name);
      continue;
    }
    if (!VALUE_FLAGS.has(name)) throw new Error(`未知参数 ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`参数 ${arg} 缺少值`);
    }
    values.set(name, value);
    i += 1;
  }
  return { values, switches };
}

/** 单个 YAML 或目录（合并其中全部 *.yaml，并做跨文件 id 查重） */
async function loadCasesFrom(path: string): Promise<EvalCase[]> {
  const yamlFiles = path.endsWith('.yaml')
    ? [path]
    : (await readdir(path))
        .filter((f) => f.endsWith('.yaml'))
        .sort()
        .map((f) => join(path, f));
  if (yamlFiles.length === 0) throw new Error(`${path} 下没有 .yaml 用例文件`);

  const all: EvalCase[] = [];
  for (const file of yamlFiles) {
    all.push(...loadCases(await readFile(file, 'utf8')));
  }
  const seen = new Set<string>();
  for (const c of all) {
    if (seen.has(c.id)) throw new Error(`跨文件用例 id 重复: ${c.id}`);
    seen.add(c.id);
  }
  return all;
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const casesPath = resolve(flags.values.get('cases') ?? resolve(here, '../cases'));
  const configDir = resolve(flags.values.get('config-dir') ?? resolve(here, '../../../config'));
  const outPath = resolve(flags.values.get('out') ?? 'eval-reports/report.md');
  const repeat = Number.parseInt(flags.values.get('repeat') ?? '1', 10);

  const cases = await loadCasesFrom(casesPath);
  // 无外部配置 = fixture 模式（共享契约的演示数据）；工厂保证每题状态隔离。
  // MySQL 模式（ORANGEHRM_MYSQL_* 环境变量）时全部题共享一个连接池——
  // orangehrm 后端只读无状态，隔离述求只针对有状态的 memory 存储。
  const mysqlConfig = mysqlConfigFromEnv(process.env);
  const mysqlBackend = mysqlConfig === null ? null : new MySqlOrangeHrmBackend(mysqlConfig);
  console.log(
    `orangehrm 后端：${mysqlBackend !== null ? `只读 MySQL ${mysqlConfig?.host}:${mysqlConfig?.port}/${mysqlConfig?.database}` : 'fixture（内置演示数据）'}`,
  );
  const espoMysqlConfig = espoMysqlConfigFromEnv(process.env);
  const espoMysqlBackend =
    espoMysqlConfig === null ? null : new MySqlEspoCrmBackend(espoMysqlConfig);
  console.log(
    `espocrm 后端：${espoMysqlBackend !== null ? `只读 MySQL ${espoMysqlConfig?.host}:${espoMysqlConfig?.port}/${espoMysqlConfig?.database}` : 'fixture（内置演示数据）'}`,
  );
  const systems: Record<string, EvalSystem> = {
    orangehrm: {
      createAdapter: () =>
        mysqlBackend !== null
          ? createOrangeHrmAdapter({ backend: mysqlBackend })
          : createOrangeHrmAdapter(),
      rbac: loadRbacConfig(await readFile(join(configDir, 'rbac.orangehrm.yaml'), 'utf8')),
    },
    // espocrm 两个后端都只读无状态，MySQL 模式（ESPOCRM_MYSQL_*）全部题共享一个连接池。
    // fixture 分支显式传 env:{}——否则 selectBackend 会读进程里的 ESPOCRM_REST_*，
    // 把「fixture 评测」悄悄接上真库 REST 写通道（写题会改动生产 CRM）。
    espocrm: {
      createAdapter: () =>
        espoMysqlBackend !== null
          ? createEspoCrmAdapter({ backend: espoMysqlBackend })
          : createEspoCrmAdapter({ env: {} }),
      rbac: loadRbacConfig(await readFile(join(configDir, 'rbac.espocrm.yaml'), 'utf8')),
    },
    memory: {
      createAdapter: () => createMemoryAdapter(new MemoryStore()),
      rbac: loadRbacConfig(await readFile(join(configDir, 'rbac.memory.yaml'), 'utf8')),
    },
  };

  let judgeInfo = '未启用（硬断言单轨）';
  let judge = null;
  if (flags.switches.has('judge')) {
    judge = judgeFromEnv(process.env);
    if (judge === null) {
      throw new Error('--judge 需要 JUDGE_BASE_URL / JUDGE_API_KEY / JUDGE_MODEL 环境变量');
    }
    judgeInfo = `${process.env.JUDGE_MODEL} @ ${process.env.JUDGE_BASE_URL}（双轨：judge 只能追加失败，不能翻案）`;
  }

  const { runs, stats } = await runEvalRepeated(
    { systems, cases, ...(judge !== null ? { judge } : {}) },
    repeat,
  );
  const firstRun = runs[0];
  if (firstRun === undefined) throw new Error('评测一轮都没跑成');

  const ablation = flags.switches.has('ablation')
    ? await runAblation({ systems, cases })
    : undefined;

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    renderReport(firstRun, {
      judgeInfo,
      ...(repeat > 1 ? { repeat: stats } : {}),
      ...(ablation !== undefined ? { ablation } : {}),
    }),
    'utf8',
  );

  console.log(
    `评测完成：${firstRun.summary.passed}/${firstRun.summary.total} 通过` +
      `${repeat > 1 ? `（${repeat} 次重复，通过率标准差 ${(stats.stddevPassRate * 100).toFixed(2)} 个百分点）` : ''}` +
      `，报告已写入 ${outPath}`,
  );
  for (const outcome of firstRun.outcomes.filter((o) => !o.passed)) {
    console.error(
      `FAIL ${outcome.evalCase.id} ${outcome.evalCase.title}: ${outcome.failures.join('; ')}`,
    );
  }
  if (stats.flakyCaseIds.length > 0) {
    console.error(`摇摆题（重复跑结果不一致）：${stats.flakyCaseIds.join(', ')}`);
  }

  if (runs.some((r) => r.redTeamFailed)) {
    console.error('红队门禁未通过：存在 expect 为 refuse/error/pending 的失败题');
    process.exitCode = 1;
  }

  // 连接池不收口 Node 进程不退出
  if (mysqlBackend !== null) await mysqlBackend.end();
  if (espoMysqlBackend !== null) await espoMysqlBackend.end();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
