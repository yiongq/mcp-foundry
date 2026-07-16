/**
 * 多域网关的 HTTP 端到端验证：同一个 /mcp 挂两个业务域，
 * 证明"通配角色的权力止步于本域"是服务器行为，不只是守卫单元行为。
 */
import type { Server } from 'node:http';
import { loadRbacConfig, MemoryAuditLogger, type SystemAdapter } from '@yiong/foundry-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFoundryServer } from './server.js';

const fakeHr: SystemAdapter = {
  system: 'fake-hr',
  tools: () => [
    { name: 'list_employees', description: '员工列表', inputSchema: z.object({}) },
    { name: 'get_salary', description: '查薪资', inputSchema: z.object({ id: z.string() }) },
  ],
  execute: async () => ({ data: [] }),
};

const fakeCrm: SystemAdapter = {
  system: 'fake-crm',
  tools: () => [
    { name: 'list_accounts', description: '客户列表', inputSchema: z.object({}) },
    { name: 'get_pipeline_summary', description: '业绩盘', inputSchema: z.object({}) },
  ],
  execute: async () => ({ data: [] }),
};

const hrRbac = loadRbacConfig(`
roles:
  hr_admin:
    tools: "*"
`);

const crmRbac = loadRbacConfig(`
roles:
  sales_manager:
    tools: "*"
`);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createFoundryServer({
    systems: [
      { adapter: fakeHr, rbac: hrRbac },
      { adapter: fakeCrm, rbac: crmRbac },
    ],
    audit: new MemoryAuditLogger(),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

const rpc = async (identity: { user: string; role: string }, body: unknown): Promise<unknown> => {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-foundry-user': identity.user,
      'x-foundry-role': identity.role,
    },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
};

const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

describe('同一 /mcp 网关挂两个业务域', () => {
  it('hr_admin（HR 域通配）：工具面只有 HR 的 2 个，CRM 工具连列表都不出现', async () => {
    const body = (await rpc({ user: 'e004', role: 'hr_admin' }, toolsList)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name)).toEqual(['list_employees', 'get_salary']);
  });

  it('sales_manager（CRM 域通配）：工具面只有 CRM 的 2 个', async () => {
    const body = (await rpc({ user: 'e005', role: 'sales_manager' }, toolsList)) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(body.result.tools.map((t) => t.name)).toEqual(['list_accounts', 'get_pipeline_summary']);
  });

  it('hr_admin 硬调 CRM 工具：结构化拒答 unknown_role（越权未遂留痕路径）', async () => {
    const body = (await rpc(
      { user: 'e004', role: 'hr_admin' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_pipeline_summary' } },
    )) as { result: { content: [{ text: string }] } };
    expect(JSON.parse(body.result.content[0].text)).toMatchObject({
      kind: 'refusal',
      reason: 'unknown_role',
    });
  });
});
