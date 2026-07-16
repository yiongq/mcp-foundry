/**
 * URL 模式 JWKS 的 HTTP 端到端验证：真起 JWKS 端点、真起 Foundry 服务、真发请求——
 * 证明"轮换吊销经由 URL 刷新生效"是服务器行为，不只是加载器行为。
 */
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadRbacConfig, MemoryAuditLogger, type SystemAdapter } from '@yiong/foundry-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createJwksUrlLoader, type JwksUrlLoader } from './jwks.js';
import { createFoundryServer } from './server.js';
import { mintIdentityTokenEs256 } from './token.js';

const fakeHr: SystemAdapter = {
  system: 'fake-hr',
  tools: () => [{ name: 'list_employees', description: '员工列表', inputSchema: z.object({}) }],
  execute: async () => ({ data: [] }),
};

const rbac = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees]
`);

function keyPair(kid: string): { pem: string; jwksBody: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    jwksBody: JSON.stringify({
      keys: [{ ...(publicKey.export({ format: 'jwk' }) as object), kid }],
    }),
  };
}

const gen1 = keyPair('url-1');
const gen2 = keyPair('url-2');

let jwksBody = gen1.jwksBody;
let jwksEndpoint: Server;
let foundry: Server;
let loader: JwksUrlLoader;
let baseUrl: string;

beforeAll(async () => {
  jwksEndpoint = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('content-type', 'application/json');
    res.end(jwksBody);
  });
  await new Promise<void>((resolve) => jwksEndpoint.listen(0, '127.0.0.1', resolve));
  const { port } = jwksEndpoint.address() as AddressInfo;

  loader = await createJwksUrlLoader(`http://127.0.0.1:${port}/jwks.json`, {
    refreshMs: 3_600_000, // 测试里用 refresh() 确定性驱动，不等定时器
  });
  foundry = createFoundryServer({
    systems: [{ adapter: fakeHr, rbac }],
    audit: new MemoryAuditLogger(),
    auth: { mode: 'token-jwks', jwks: loader.load },
  });
  await new Promise<void>((resolve) => foundry.listen(0, resolve));
  const address = foundry.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  loader.stop();
  await new Promise<void>((resolve, reject) =>
    foundry.close((err) => (err ? reject(err) : resolve())),
  );
  await new Promise<void>((resolve, reject) =>
    jwksEndpoint.close((err) => (err ? reject(err) : resolve())),
  );
});

const toolsList = async (token: string): Promise<Response> =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });

describe('token-jwks 模式（JWKS 来自 URL）', () => {
  it('URL 拉到的公钥验签生效；轮换后旧 kid 被吊销、新 kid 顶上', async () => {
    const tokenGen1 = mintIdentityTokenEs256(
      gen1.pem,
      'url-1',
      { userId: 'e002', role: 'employee' },
      600,
    );
    expect((await toolsList(tokenGen1)).status).toBe(200);

    // 轮换：端点只发布 url-2，刷新后 url-1 即吊销——旧令牌 401，新令牌 200
    jwksBody = gen2.jwksBody;
    await loader.refresh();
    expect((await toolsList(tokenGen1)).status).toBe(401);

    const tokenGen2 = mintIdentityTokenEs256(
      gen2.pem,
      'url-2',
      { userId: 'e002', role: 'employee' },
      600,
    );
    expect((await toolsList(tokenGen2)).status).toBe(200);
  });
});
