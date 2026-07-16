/**
 * demo 入口：fixture OrangeHRM 适配器 + 演示 RBAC + JSONL 审计。
 *
 * 鉴权模式由 FOUNDRY_IDENTITY_SECRET 决定：设了 → token 模式（只认
 * Authorization: Bearer，令牌用 mint-token 签发）；没设 → demo 头模式并打警告。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOrangeHrmAdapter } from '@yiong/foundry-adapter-orangehrm';
import { JsonlAuditLogger, loadRbacConfig } from '@yiong/foundry-core';
import { type AuthConfig, createFoundryServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url);
const rbacYaml = await readFile(new URL('config/rbac.orangehrm.yaml', repoRoot), 'utf8');

const secret = process.env.FOUNDRY_IDENTITY_SECRET;
const auth: AuthConfig = secret ? { mode: 'token', secret } : { mode: 'headers' };

const server = createFoundryServer({
  adapters: [createOrangeHrmAdapter()],
  rbac: loadRbacConfig(rbacYaml),
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
