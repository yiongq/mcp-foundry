/**
 * demo 入口：fixture 后端的 OrangeHRM（HR 域）+ EspoCRM（CRM 域）适配器，
 * RBAC 按系统分治 + JSONL 审计。demo 身份（employee/hr_admin）只登记在 HR 域，
 * CRM 域的角色是 sales_rep/sales_manager——同一网关、两个业务域、权力互不越界。
 *
 * 鉴权模式按优先级：FOUNDRY_IDENTITY_JWKS（token-jwks，ES256/RS256 非对称验签，
 * 文件热重载）→ FOUNDRY_IDENTITY_SECRET（token，HS256 共享密钥）→ demo 头模式并打警告。
 * 两个都设时 JWKS 生效——HS256 令牌在 token-jwks 模式下没有验签路径，会被拒。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEspoCrmAdapter } from '@yiong/foundry-adapter-espocrm';
import { createOrangeHrmAdapter } from '@yiong/foundry-adapter-orangehrm';
import { JsonlAuditLogger, loadRbacConfig } from '@yiong/foundry-core';
import { type AuthConfig, createFoundryServer, createJwksFileLoader } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url);
const loadRbac = async (file: string) =>
  loadRbacConfig(await readFile(new URL(`config/${file}`, repoRoot), 'utf8'));

const jwksPath = process.env.FOUNDRY_IDENTITY_JWKS;
const secret = process.env.FOUNDRY_IDENTITY_SECRET;
let auth: AuthConfig;
if (jwksPath) {
  const loadJwks = createJwksFileLoader(jwksPath);
  loadJwks(); // 配置错误（文件缺失/格式坏/kid 重复）拒绝启动，不带病上线
  auth = { mode: 'token-jwks', jwks: loadJwks };
  if (secret) {
    console.warn(
      'identity: FOUNDRY_IDENTITY_JWKS 与 FOUNDRY_IDENTITY_SECRET 同时设置——JWKS 生效，HS256 令牌将被拒绝。',
    );
  }
} else {
  auth = secret ? { mode: 'token', secret } : { mode: 'headers' };
}

const server = createFoundryServer({
  systems: [
    { adapter: createOrangeHrmAdapter(), rbac: await loadRbac('rbac.orangehrm.yaml') },
    { adapter: createEspoCrmAdapter(), rbac: await loadRbac('rbac.espocrm.yaml') },
  ],
  audit: new JsonlAuditLogger(fileURLToPath(new URL('audit/foundry.jsonl', repoRoot))),
  auth,
});

const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3100;
server.listen(port, () => {
  console.log(`mcp-foundry: http://localhost:${port}/mcp`);
  if (auth.mode === 'token-jwks') {
    console.log(
      `identity: signed token via JWKS (${jwksPath}, ES256/RS256, mtime 热重载; mint via \`pnpm mint-token --key … --kid …\`)`,
    );
  } else if (auth.mode === 'token') {
    console.log('identity: signed token (Authorization: Bearer …, mint via `pnpm mint-token`)');
  } else {
    console.warn(
      'identity: DEMO trust headers x-foundry-user / x-foundry-role — unsigned, anyone can claim any role.',
    );
    console.warn('set FOUNDRY_IDENTITY_SECRET to enforce signed identity tokens.');
  }
});
