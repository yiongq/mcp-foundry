/**
 * 飞书 bot 入口。
 *
 * 环境变量（缺省从本包 .env 读取，见 .env 注释）：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET      —— 企业自建应用凭据
 *   FOUNDRY_LLM_BASE_URL / _API_KEY / _MODEL —— OpenAI 兼容对话模型
 *   ORANGEHRM_MYSQL_*（可选）              —— 有则 HR 数据走真实 OrangeHRM 只读库，否则 fixture
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createMemoryAdapter, MemoryStore } from '@yiong/foundry-adapter-memory';
import { createOrangeHrmAdapter } from '@yiong/foundry-adapter-orangehrm';
import { Guard, JsonlAuditLogger, loadRbacConfig } from '@yiong/foundry-core';
import { startBot } from '../src/bot.js';
import { loadIdentityMap } from '../src/identity.js';
import { GuardedToolset } from '../src/toolset.js';

// 极简 .env 装载：KEY=VALUE 逐行，已有环境变量优先（便于临时覆盖）
function loadDotEnv(url: URL): void {
  let text: string;
  try {
    text = readFileSync(url, 'utf8');
  } catch {
    return;
  }
  for (const line of text.split('\n')) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2];
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`缺少环境变量 ${name}（填在 packages/feishu/.env）`);
  }
  return value;
}

const repoRoot = new URL('../../../', import.meta.url);
loadDotEnv(new URL('../.env', import.meta.url));

const rbacHr = loadRbacConfig(await readFile(new URL('config/rbac.orangehrm.yaml', repoRoot), 'utf8'));
const rbacMemory = loadRbacConfig(
  await readFile(new URL('config/rbac.memory.yaml', repoRoot), 'utf8'),
);
const identityMap = loadIdentityMap(
  await readFile(new URL('config/identity.feishu.yaml', repoRoot), 'utf8'),
);

const audit = new JsonlAuditLogger(fileURLToPath(new URL('audit/foundry.jsonl', repoRoot)));
// 记忆存储进程级单例：跨会话记忆在 bot 生命周期内真实存续（重启即清，演示口径）
const memoryStore = new MemoryStore();
const toolset = new GuardedToolset([
  { adapter: createOrangeHrmAdapter(), guard: new Guard(rbacHr, audit) },
  { adapter: createMemoryAdapter(memoryStore), guard: new Guard(rbacMemory, audit) },
]);

const boundCount = Object.keys(identityMap).length;
console.log(
  `[bot] 身份绑定 ${boundCount} 人；HR 后端：${process.env.ORANGEHRM_MYSQL_HOST ? `只读 MySQL ${process.env.ORANGEHRM_MYSQL_HOST}` : 'fixture'}`,
);

const bot = await startBot({
  appId: required('FEISHU_APP_ID'),
  appSecret: required('FEISHU_APP_SECRET'),
  identityMap,
  agent: {
    toolset,
    llm: {
      baseUrl: required('FOUNDRY_LLM_BASE_URL'),
      apiKey: required('FOUNDRY_LLM_API_KEY'),
      model: required('FOUNDRY_LLM_MODEL'),
      // 对话延迟优先：思考链让一次问答慢到 30s+，关掉后 ~2s（2026-07-16 实测）
      disableThinking: true,
      onTiming: ({ turn, ms, toolCalls }) =>
        console.log(`[llm] 第 ${turn} 轮 ${ms}ms（tool_calls: ${toolCalls}）`),
    },
  },
});

process.on('SIGINT', () => {
  void bot.close().finally(() => process.exit(0));
});
