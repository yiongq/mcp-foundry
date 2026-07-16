/**
 * demo 入口：fixture 后端的 OrangeHRM（HR 域）+ EspoCRM（CRM 域）适配器，
 * RBAC 按系统分治 + JSONL 审计。demo 身份（employee/hr_admin）只登记在 HR 域，
 * CRM 域的角色是 sales_rep/sales_manager——同一网关、两个业务域、权力互不越界。
 *
 * 鉴权模式由 FOUNDRY_IDENTITY_SECRET 决定：设了 → token 模式（只认
 * Authorization: Bearer，令牌用 mint-token 签发）；没设 → demo 头模式并打警告。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createEspoCrmAdapter } from '@yiong/foundry-adapter-espocrm';
import { createOrangeHrmAdapter } from '@yiong/foundry-adapter-orangehrm';
import { JsonlAuditLogger, loadRbacConfig } from '@yiong/foundry-core';
import { type AuthConfig, createFoundryServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url);
const loadRbac = async (file: string) =>
  loadRbacConfig(await readFile(new URL(`config/${file}`, repoRoot), 'utf8'));

const secret = process.env.FOUNDRY_IDENTITY_SECRET;
const auth: AuthConfig = secret ? { mode: 'token', secret } : { mode: 'headers' };

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
  if (auth.mode === 'token') {
    console.log('identity: signed token (Authorization: Bearer …, mint via `pnpm mint-token`)');
  } else {
    console.warn(
      'identity: DEMO trust headers x-foundry-user / x-foundry-role — unsigned, anyone can claim any role.',
    );
    console.warn('set FOUNDRY_IDENTITY_SECRET to enforce signed identity tokens.');
  }
});
