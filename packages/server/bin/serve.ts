/**
 * demo 入口：fixture OrangeHRM 适配器 + 演示 RBAC + JSONL 审计。
 *
 * 身份取自 x-foundry-user / x-foundry-role 请求头——MVP 的 demo 信任层；
 * 生产身份来自飞书事件/网关签名（W3 接入）。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createOrangeHrmAdapter } from '@yiong/foundry-adapter-orangehrm';
import { JsonlAuditLogger, loadRbacConfig } from '@yiong/foundry-core';
import { createFoundryServer } from '../src/index.js';

const repoRoot = new URL('../../../', import.meta.url);
const rbacYaml = await readFile(new URL('config/rbac.orangehrm.yaml', repoRoot), 'utf8');

const server = createFoundryServer({
  adapters: [createOrangeHrmAdapter()],
  rbac: loadRbacConfig(rbacYaml),
  audit: new JsonlAuditLogger(fileURLToPath(new URL('audit/foundry.jsonl', repoRoot))),
});

const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3100;
server.listen(port, () => {
  console.log(`mcp-foundry: http://localhost:${port}/mcp`);
  console.log('demo identity headers: x-foundry-user / x-foundry-role (e.g. e002 / employee)');
});
