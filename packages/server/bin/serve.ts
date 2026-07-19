/**
 * demo 入口：fixture 后端的 OrangeHRM（HR 域）+ Twenty（CRM 域）适配器，
 * RBAC 按系统分治 + JSONL 审计。demo 身份（employee/hr_admin）只登记在 HR 域，
 * CRM 域的角色是 sales_rep/sales_manager——同一网关、两个业务域、权力互不越界。
 *
 * 鉴权模式按优先级：FOUNDRY_IDENTITY_JWKS（token-jwks，ES256/RS256 非对称验签；
 * 值以 http(s):// 开头走 URL 定时拉取，否则按本地文件 mtime 热重载）→
 * FOUNDRY_IDENTITY_SECRET（token，HS256 共享密钥）→ demo 头模式并打警告。
 * 两个都设时 JWKS 生效——HS256 令牌在 token-jwks 模式下没有验签路径，会被拒。
 * URL 模式下 FOUNDRY_IDENTITY_JWKS_REFRESH（秒，默认 300）定刷新间隔——
 * 固定轮询、不读 Cache-Control；这个数就是吊销时延上界，配错拒绝启动。
 */
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOrangeHrmAdapter } from '@yiong/foundry-adapter-orangehrm';
import { createTwentyAdapter } from '@yiong/foundry-adapter-twenty';
import {
  type AuditLogger,
  JsonlApprovalStore,
  JsonlAuditLogger,
  loadRbacConfig,
  SignedJsonlAuditLogger,
} from '@yiong/foundry-core';
import {
  type AuthConfig,
  createFoundryServer,
  createJwksFileLoader,
  createJwksUrlLoader,
} from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url);
const loadRbac = async (file: string) =>
  loadRbacConfig(await readFile(new URL(`config/${file}`, repoRoot), 'utf8'));

/** 大小写不敏感地识别 URL（HTTP:// 也算 URL，进 URL 加载器被 https 纪律拒掉，而不是掉进文件分支报一个莫名其妙的 ENOENT）。 */
const isJwksUrl = (source: string): boolean => /^https?:\/\//i.test(source);

/** 配错不能静默回默认值——拒绝启动（同「不带病上线」纪律）。上界防 setInterval 毫秒溢出钳到 1ms 变热循环。 */
function secondsFromEnv(name: string, fallback: number | undefined, min: number): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < min || seconds > 2_147_483) {
    throw new Error(`${name} must be a number of seconds in [${min}, 2147483], got "${raw}"`);
  }
  return seconds;
}

const jwksSource = process.env.FOUNDRY_IDENTITY_JWKS;
const secret = process.env.FOUNDRY_IDENTITY_SECRET;
// 可选受众/签发方绑定：设了 FOUNDRY_IDENTITY_AUD / _ISS 即让网关只认「发给自己、来自受信
// 签发方」的令牌——多签发方共用一套 JWKS 时，防止别的服务的令牌凭 role 声明在此被接受。
const identityBinding = {
  ...(process.env.FOUNDRY_IDENTITY_AUD ? { expectedAud: process.env.FOUNDRY_IDENTITY_AUD } : {}),
  ...(process.env.FOUNDRY_IDENTITY_ISS ? { expectedIss: process.env.FOUNDRY_IDENTITY_ISS } : {}),
};
let auth: AuthConfig;
let identityBanner: string;
if (jwksSource) {
  if (isJwksUrl(jwksSource)) {
    const refreshSeconds = secondsFromEnv('FOUNDRY_IDENTITY_JWKS_REFRESH', 300, 5) as number;
    // 可选 fail-closed：距上次成功刷新超过该秒数后验签一律 401（默认不设，可用性优先）。
    // 下限 2×间隔+10s 拉取超时：稳态陈旧度会合法冲到「间隔+在途时延」，还要容一次失败轮询
    const maxStaleSeconds = secondsFromEnv(
      'FOUNDRY_IDENTITY_JWKS_MAX_STALE',
      undefined,
      2 * refreshSeconds + 10,
    );
    // 首次拉取失败（连不上/非 2xx/schema 坏）在这里抛，拒绝启动
    const loader = await createJwksUrlLoader(jwksSource, {
      refreshMs: refreshSeconds * 1000,
      maxStaleMs: maxStaleSeconds === undefined ? undefined : maxStaleSeconds * 1000,
    });
    auth = { mode: 'token-jwks', jwks: loader.load, ...identityBinding };
    identityBanner =
      `identity: signed token via JWKS URL (${jwksSource}, ES256/RS256, 每 ${refreshSeconds}s 刷新，忽略 Cache-Control${maxStaleSeconds === undefined ? '' : `，超 ${maxStaleSeconds}s 未刷新即 fail-closed`})\n` +
      `identity: 轮换纪律——新 kid 先发布到 JWKS 端点、等 ≥2 个刷新间隔（容一次失败轮询）再用它签发；吊销最迟一个刷新间隔生效`;
  } else if (jwksSource.includes('://')) {
    // 像 URL 但 scheme 不对（htttps:// 之类的手滑）——给定向报错，别掉进文件分支报 ENOENT
    throw new Error(
      `FOUNDRY_IDENTITY_JWKS looks like a URL but only http(s) is supported: "${jwksSource}"`,
    );
  } else {
    const loadJwks = createJwksFileLoader(jwksSource);
    loadJwks(); // 配置错误（文件缺失/格式坏/kid 重复）拒绝启动，不带病上线
    auth = { mode: 'token-jwks', jwks: loadJwks, ...identityBinding };
    identityBanner = `identity: signed token via JWKS (${jwksSource}, ES256/RS256, mtime 热重载; mint via \`pnpm mint-token --key … --kid …\`)`;
  }
  if (secret) {
    console.warn(
      'identity: FOUNDRY_IDENTITY_JWKS 与 FOUNDRY_IDENTITY_SECRET 同时设置——JWKS 生效，HS256 令牌将被拒绝。',
    );
  }
} else if (secret) {
  auth = { mode: 'token', secret, ...identityBinding };
  identityBanner = 'identity: signed token (Authorization: Bearer …, mint via `pnpm mint-token`)';
} else if (process.env.FOUNDRY_DEMO === '1' || process.env.FOUNDRY_DEMO === 'true') {
  // 未签名的 demo 头模式必须**显式**开启（FOUNDRY_DEMO=1），不再是「忘了配签名身份」时的
  // 静默兜底。头模式下 x-foundry-user 可自证任意身份，自审批等身份不变量形同虚设（发起人
  // 只要「自称」审批人就能批自己的单）。安全产品的默认必须 fail-closed：把不安全形态变成
  // 一个需要主动打开的开关，而不是需要主动记得避免的陷阱——不再依赖 NODE_ENV=production 被设对。
  auth = { mode: 'headers' };
  identityBanner = '';
} else {
  // 既无签名身份、又未显式开 demo：拒绝启动，而不是偷偷跑成不安全形态。
  throw new Error(
    '必须配置签名身份：设 FOUNDRY_IDENTITY_JWKS（推荐 ES256/RS256）或 FOUNDRY_IDENTITY_SECRET（HS256）。' +
      '仅本地演示可设 FOUNDRY_DEMO=1 显式启用未签名头模式（x-foundry-user 自证身份，任何人可自称任意角色）。',
  );
}

// 调优旋钮只在 JWKS URL 模式下生效——其他模式下设了不能静默忽略（配置漂移的坑要出声）
const ignoredJwksTuning = ['FOUNDRY_IDENTITY_JWKS_REFRESH', 'FOUNDRY_IDENTITY_JWKS_MAX_STALE'].filter(
  (name) => process.env[name],
);
if (!(jwksSource && isJwksUrl(jwksSource)) && ignoredJwksTuning.length > 0) {
  console.warn(
    `identity: ${ignoredJwksTuning.join(' / ')} 只在 JWKS URL 模式（FOUNDRY_IDENTITY_JWKS=http(s)://…）下生效，当前配置将忽略。`,
  );
}

// 审计后端：设了 FOUNDRY_AUDIT_SIGNING_KEY（Ed25519 私钥 PEM 路径）即开启防篡改
// 签名哈希链——每条记录带 seq/prevHash/hash/sig，篡改断链、伪造验签不过，校验只需公钥
// （verify-audit CLI）。不设则明文 JSONL（本地/演示够用，生产建议开启）。
const auditPath = fileURLToPath(new URL('audit/foundry.jsonl', repoRoot));
const auditKeyPath = process.env.FOUNDRY_AUDIT_SIGNING_KEY;
let audit: AuditLogger;
let auditBanner: string;
if (auditKeyPath) {
  const privateKey = createPrivateKey(readFileSync(auditKeyPath, 'utf8'));
  audit = new SignedJsonlAuditLogger(auditPath, privateKey);
  auditBanner =
    'audit: Ed25519 签名哈希链（防篡改）；校验 pnpm --filter @yiong/foundry-server run verify-audit';
} else {
  audit = new JsonlAuditLogger(auditPath);
  auditBanner = 'audit: 明文 JSONL（未签名——设 FOUNDRY_AUDIT_SIGNING_KEY 开启防篡改哈希链）';
}

// CRM 域走 Twenty 适配器（fixture 或真库 REST，由 TWENTY_API_* 决定）。
const server = createFoundryServer({
  systems: [
    { adapter: createOrangeHrmAdapter(), rbac: await loadRbac('rbac.orangehrm.yaml') },
    { adapter: createTwentyAdapter(), rbac: await loadRbac('rbac.twenty.yaml') },
  ],
  audit,
  // 与审计同目录：复用同一个持久化卷与 rsync 排除规则。存 args 原文（续跑必需），同级对待
  approvals: new JsonlApprovalStore(fileURLToPath(new URL('audit/approvals.jsonl', repoRoot))),
  auth,
});

const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3100;

// 运行时护栏：显式设超时，别吃 Node 默认（requestTimeout 300s）——慢速/挂起连接不白占容量。
server.requestTimeout = 30_000;
server.headersTimeout = 15_000;
server.keepAliveTimeout = 20_000;

server.listen(port, () => {
  console.log(`mcp-foundry: http://localhost:${port}/mcp`);
  console.log(`crm backend: twenty（${process.env.TWENTY_API_URL ? 'REST 真库' : 'fixture'}）`);
  console.log(auditBanner);
  if (auth.mode === 'headers') {
    console.warn(
      'identity: DEMO trust headers x-foundry-user / x-foundry-role — unsigned, anyone can claim any role.',
    );
    console.warn('set FOUNDRY_IDENTITY_SECRET to enforce signed identity tokens.');
  } else {
    console.log(identityBanner);
  }
});

// 优雅关闭：容器 stop/redeploy 发 SIGTERM。Dockerfile 直接 exec node（serve.ts 即 PID1），
// 信号能收到——停止收新连接、放行在途请求、到点强制退出，别把在途写/审计追加截断成半行。
let shuttingDown = false;
const shutdown = (signal: string): void => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received — draining in-flight requests, then exiting`);
  const forced = setTimeout(() => {
    console.error('graceful shutdown timed out (10s) — forcing exit');
    process.exit(1);
  }, 10_000);
  forced.unref();
  server.close((err) => {
    if (err) {
      console.error('server.close error:', err.message);
      process.exit(1);
    }
    clearTimeout(forced);
    console.log('stopped accepting connections — bye');
    process.exit(0);
  });
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
