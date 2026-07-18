/**
 * 回归：真实 espocrm 适配器（含四个写工具）挂上 MCP server 后，tools/list 与
 * tools/call 都不能 500。曾经 update_contact 的入参 schema 用了 .refine → ZodEffects，
 * 而 registry.toRawShape 只收 ZodObject，导致 buildMcpServer 注册时抛错、整个 CRM 域
 * （连读工具）全部 500。其余 server 测试用的是裸 z.object 的 fake adapter，抓不到这个。
 */
import { readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { createEspoCrmAdapter } from '@yiong/foundry-adapter-espocrm';
import { loadRbacConfig, MemoryApprovalStore, MemoryAuditLogger } from '@yiong/foundry-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFoundryServer } from './server.js';

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const rbac = loadRbacConfig(
    await readFile(new URL('../../../config/rbac.espocrm.yaml', import.meta.url), 'utf8'),
  );
  server = createFoundryServer({
    systems: [{ adapter: createEspoCrmAdapter({ env: {} }), rbac }],
    audit: new MemoryAuditLogger(),
    approvals: new MemoryApprovalStore(),
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

async function rpc(method: string, params: unknown, headers: Record<string, string>) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

const REP = { 'x-foundry-user': 'e007', 'x-foundry-role': 'sales_rep' };

describe('espocrm 写工具挂 MCP（ZodEffects 回归）', () => {
  it('tools/list 不 500，且 sales_rep 看到 10 个工具（6 读 + 4 写）', async () => {
    const { status, body } = await rpc('tools/list', {}, REP);
    expect(status).toBe(200);
    const tools = (body.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain('update_contact');
    expect(names).toContain('delete_contact');
    expect(names).toContain('create_contact');
    expect(names).toContain('update_opportunity_stage');
    expect(names).toContain('list_contacts');
    expect(names).toHaveLength(10); // get_pipeline_summary 不在 sales_rep 白名单
  });

  it('tools/call update_contact 不 500——涉审工具返回 pending（而非注册期崩溃）', async () => {
    const { status, body } = await rpc(
      'tools/call',
      { name: 'update_contact', arguments: { contact_id: 'c001', title: '副总裁' } },
      REP,
    );
    expect(status).toBe(200);
    const text = (body.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}';
    expect(JSON.parse(text).kind).toBe('pending');
  });

  it('tools/call 读工具 list_contacts 正常返回 ok（不被写工具的注册问题波及）', async () => {
    const { status, body } = await rpc('tools/call', { name: 'list_contacts', arguments: {} }, REP);
    expect(status).toBe(200);
    const text = (body.result as { content: Array<{ text: string }> }).content[0]?.text ?? '{}';
    expect(JSON.parse(text).kind).toBe('ok');
  });
});
