/**
 * token-jwks 模式的 HTTP 端到端验证：真起服务、真发请求——
 * 证明"HS256 令牌在非对称模式下没有验签路径"是服务器行为，不只是函数行为。
 */
import { generateKeyPairSync } from 'node:crypto';
import type { Server } from 'node:http';
import { loadRbacConfig, MemoryAuditLogger, type SystemAdapter } from '@yiong/foundry-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { IdentityPublicJwk } from './jwks.js';
import { createFoundryServer } from './server.js';
import { mintIdentityToken, mintIdentityTokenEs256 } from './token.js';

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

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const JWK = { ...(publicKey.export({ format: 'jwk' }) as object), kid: 'e2e' } as IdentityPublicJwk;

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  server = createFoundryServer({
    systems: [{ adapter: fakeHr, rbac }],
    audit: new MemoryAuditLogger(),
    auth: { mode: 'token-jwks', jwks: { keys: [JWK] } },
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

describe('token-jwks 模式服务器', () => {
  it('有效 ES256 令牌 → 工具面按令牌里的角色收窄', async () => {
    const token = mintIdentityTokenEs256(PEM, 'e2e', { userId: 'e002', role: 'employee' }, 600);
    const res = await toolsList({ authorization: `Bearer ${token}` });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(['list_employees']);
  });

  it('HS256 令牌（哪怕密钥"正确"）→ 401：非对称模式下没有共享密钥验签路径', async () => {
    const hs256 = mintIdentityToken(
      'some-shared-secret-16ch',
      { userId: 'e004', role: 'hr_admin' },
      600,
    );
    const res = await toolsList({ authorization: `Bearer ${hs256}` });
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toBe('invalid identity token');
  });

  it('伪造 x-foundry-* 头 → 401，不在信任路径上', async () => {
    const res = await toolsList({ 'x-foundry-user': 'e004', 'x-foundry-role': 'hr_admin' });
    expect(res.status).toBe(401);
  });
});
