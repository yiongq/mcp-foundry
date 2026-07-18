/**
 * 飞书 bot 入口。
 *
 * 环境变量（缺省从本包 .env 读取，见 .env 注释）：
 *   FEISHU_APP_ID / FEISHU_APP_SECRET      —— 企业自建应用凭据
 *   FOUNDRY_LLM_BASE_URL / _API_KEY / _MODEL —— OpenAI 兼容对话模型
 *   ORANGEHRM_MYSQL_*（可选）              —— 有则 HR 数据走真实 OrangeHRM 只读库，否则 fixture
 *   TWENTY_API_*（可选）                   —— 有则 CRM 数据走真实 Twenty REST（Bearer），否则 fixture
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createMemoryAdapter, MemoryStore } from '@yiong/foundry-adapter-memory';
import { createOrangeHrmAdapter, mysqlConfigFromEnv } from '@yiong/foundry-adapter-orangehrm';
import { createTwentyAdapter } from '@yiong/foundry-adapter-twenty';
import { Guard, JsonlApprovalStore, JsonlAuditLogger, loadRbacConfig } from '@yiong/foundry-core';
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
// CRM 域走 Twenty 适配器（fixture 或真库 REST，由 TWENTY_API_* 决定）
const crmAdapter = createTwentyAdapter();
const rbacCrm = loadRbacConfig(
  await readFile(new URL('config/rbac.twenty.yaml', repoRoot), 'utf8'),
);
const rbacMemory = loadRbacConfig(
  await readFile(new URL('config/rbac.memory.yaml', repoRoot), 'utf8'),
);
// 身份表每条消息重读：改绑定（演示切角色）保存即生效，无需重启。
// 解析失败沿用上一份有效映射——半保存状态的 YAML 不能炸掉消息处理。
const identityUrl = new URL('config/identity.feishu.yaml', repoRoot);
let identityMap = loadIdentityMap(await readFile(identityUrl, 'utf8'));
const loadIdentities = async (): Promise<typeof identityMap> => {
  try {
    identityMap = loadIdentityMap(await readFile(identityUrl, 'utf8'));
  } catch (err) {
    console.error(
      '[bot] identity.feishu.yaml 重载失败，沿用上一份有效映射:',
      err instanceof Error ? err.message : String(err),
    );
  }
  return identityMap;
};

const audit = new JsonlAuditLogger(fileURLToPath(new URL('audit/foundry.jsonl', repoRoot)));
// 审批单存储：飞书进程自己的文件（与 MCP 网关各管各的单——飞书单卡片批、
// 网关单走 REST 端点批；两个进程不共享内存态，也就不共享单据文件）。
// 存 args 原文（续跑必需），与审计同目录同纪律：不进 git、不出持久化卷。
const approvalStore = new JsonlApprovalStore(
  fileURLToPath(new URL('audit/approvals.feishu.jsonl', repoRoot)),
);
// 记忆存储进程级单例：跨会话记忆在 bot 生命周期内真实存续（重启即清，演示口径）
const memoryStore = new MemoryStore();
const toolset = new GuardedToolset([
  { adapter: createOrangeHrmAdapter(), guard: new Guard(rbacHr, audit, { approvals: approvalStore }) },
  { adapter: crmAdapter, guard: new Guard(rbacCrm, audit, { approvals: approvalStore }) },
  {
    adapter: createMemoryAdapter(memoryStore),
    guard: new Guard(rbacMemory, audit, { approvals: approvalStore }),
  },
]);

const boundCount = Object.keys(identityMap).length;
// 日志与适配器用同一套探测（host+user+password 齐才算真库）——env 不全时适配器
// 静默回落 fixture，日志绝不能反着说"已连真库"（真机复验的口径就毁在这种误报上）
const hrMysql = mysqlConfigFromEnv(process.env);
const crmDesc = process.env.TWENTY_API_URL ? `twenty REST ${process.env.TWENTY_API_URL}` : 'twenty fixture';
console.log(
  `[bot] 身份绑定 ${boundCount} 人；HR 后端：${hrMysql ? `只读 MySQL ${hrMysql.host}:${hrMysql.port}` : 'fixture'}；CRM 后端：${crmDesc}`,
);

const bot = await startBot({
  appId: required('FEISHU_APP_ID'),
  appSecret: required('FEISHU_APP_SECRET'),
  identityMap: loadIdentities,
  approvals: {
    store: approvalStore,
    audit,
    rbacBySystem: new Map([
      ['orangehrm', rbacHr],
      ['twenty', rbacCrm],
      ['memory', rbacMemory],
    ]),
    // 不设则审批卡片发到触发对话本身（单人 dogfood 缺省）；设了发到指定会话（审批群）
    ...(process.env.FEISHU_APPROVAL_CHAT_ID
      ? { approvalChatId: process.env.FEISHU_APPROVAL_CHAT_ID }
      : {}),
  },
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
