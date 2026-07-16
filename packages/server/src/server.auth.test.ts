/**
 * token 模式的 HTTP 端到端验证：真起服务、真发请求——
 * 证明"伪造 x-foundry-* 头拿不到任何东西"是服务器行为，不只是函数行为。
 */
import type { Server } from 'node:http';
import { loadRbacConfig, MemoryAuditLogger, type SystemAdapter } from '@yiong/foundry-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFoundryServer } from './server.js';
import { mintIdentityToken } from './token.js';

const SECRET = 'test-secret-at-least-16-chars';

const fakeHr: SystemAdapter = {
  system: 'fake-hr',
  tools: () => [
    { name: 'list_employees', description: '员工列表', inputSchema: z.object({}) },
    { name: 'get_salary', description: '查薪资', inputSchema: z.object({ id: z.string() }) },
  ],
  execute: async () => ({ data: [] }),
};

const rbac = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees]
  hr_admin:
    tools: [list_employees, get_salary]
`);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createFoundryServer({
    adapters: [fakeHr],
    rbac,
    audit: new MemoryAuditLogger(),
    auth: { mode: 'token', secret: SECRET },
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

const toolsList = async (headers: Record<string, string>): Promise<Response> =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

describe('token 模式服务器', () => {
  it('伪造 x-foundry-* 头 → 401，拿不到工具列表', async () => {
    const res = await toolsList({ 'x-foundry-user': 'e004', 'x-foundry-role': 'hr_admin' });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('missing Authorization: Bearer <token> header');
  });

  it('有效令牌 → 工具面按令牌里的角色收窄', async () => {
    const token = mintIdentityToken(SECRET, { userId: 'e002', role: 'employee' }, 3600);
    const res = await toolsList({ authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(['list_employees']);
  });

  it('篡改令牌提权 → 401 invalid identity token', async () => {
    const token = mintIdentityToken(SECRET, { userId: 'e002', role: 'employee' }, 3600);
    const [header, payload] = token.split('.') as [string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      role: string;
    };
    claims.role = 'hr_admin';
    const forgedPayload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const forged = `${header}.${forgedPayload}.${token.split('.')[2]}`;
    const res = await toolsList({ authorization: `Bearer ${forged}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('invalid identity token');
  });
});
