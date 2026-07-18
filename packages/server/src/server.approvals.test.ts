/**
 * 审批闸门的 HTTP 端到端验证：MCP 调用得 pending → REST 批单 → 重试消票执行。
 * 走 headers 鉴权（demo 信任层）——闸门与鉴权模式无关，token 模式的行为由 auth 测试覆盖。
 */
import type { Server } from 'node:http';
import {
  loadRbacConfig,
  MemoryApprovalStore,
  MemoryAuditLogger,
  type SystemAdapter,
} from '@yiong/foundry-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFoundryServer } from './server.js';

const executed: string[] = [];

const fakeCrm: SystemAdapter = {
  system: 'fake-crm',
  tools: () => [
    { name: 'list_contacts', description: '列联系人', inputSchema: z.object({}) },
    { name: 'delete_contact', description: '删联系人', inputSchema: z.object({ id: z.string() }) },
  ],
  execute: async (call) => {
    executed.push(call.tool);
    return { data: { done: true } };
  },
};

const rbac = loadRbacConfig(`
roles:
  sales_rep:
    tools: [list_contacts, delete_contact]
    approval: [delete_contact]
  sales_manager:
    tools: "*"
    approver: true
`);

let server: Server;
let baseUrl: string;
const store = new MemoryApprovalStore();

beforeAll(async () => {
  server = createFoundryServer({
    systems: [{ adapter: fakeCrm, rbac }],
    audit: new MemoryAuditLogger(),
    approvals: store,
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

const REP_HEADERS = { 'x-foundry-user': 'e007', 'x-foundry-role': 'sales_rep' };
const MANAGER_HEADERS = { 'x-foundry-user': 'e005', 'x-foundry-role': 'sales_manager' };

async function callTool(
  headers: Record<string, string>,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ kind: string; approvalId?: string; reason?: string }> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const body = (await res.json()) as {
    result: { content: Array<{ text: string }> };
  };
  return JSON.parse(body.result.content[0]?.text ?? '{}');
}

describe('审批闸门 HTTP 全链路', () => {
  it('pending → 看单 → 批准 → 重试消票执行', async () => {
    const pending = await callTool(REP_HEADERS, 'delete_contact', { id: 'c1' });
    expect(pending.kind).toBe('pending');
    expect(executed).toHaveLength(0);
    const approvalId = pending.approvalId;
    expect(approvalId).toBeDefined();

    // 经理看单：能看到这张 pending
    const listRes = await fetch(`${baseUrl}/approvals`, { headers: MANAGER_HEADERS });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { approvals: Array<{ id: string; tool: string }> };
    expect(listBody.approvals.map((a) => a.id)).toContain(approvalId);
    expect(listBody.approvals[0]?.tool).toBe('delete_contact');

    // 发起人自己不是 approver：看单为空、批单 403
    const repList = await fetch(`${baseUrl}/approvals`, { headers: REP_HEADERS });
    expect(((await repList.json()) as { approvals: unknown[] }).approvals).toHaveLength(0);
    const repDecide = await fetch(`${baseUrl}/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...REP_HEADERS },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(repDecide.status).toBe(403);

    // 经理批准
    const decide = await fetch(`${baseUrl}/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...MANAGER_HEADERS },
      body: JSON.stringify({ decision: 'approve' }),
    });
    expect(decide.status).toBe(200);
    expect(((await decide.json()) as { status: string }).status).toBe('approved');

    // 重复批复 → 409
    const again = await fetch(`${baseUrl}/approvals/${approvalId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...MANAGER_HEADERS },
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(again.status).toBe(409);

    // 发起人重试同一调用 → 消票执行
    const resumed = await callTool(REP_HEADERS, 'delete_contact', { id: 'c1' });
    expect(resumed.kind).toBe('ok');
    expect(executed).toEqual(['delete_contact']);
  });

  it('批单接口的输入防线：坏 JSON 400、坏 decision 400、不存在 404、未鉴权 401', async () => {
    const bad = await fetch(`${baseUrl}/approvals/whatever`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...MANAGER_HEADERS },
      body: 'not json',
    });
    expect(bad.status).toBe(400);

    const record = await store.create({
      system: 'fake-crm',
      tool: 'delete_contact',
      args: { id: 'c9' },
      argsHash: 'h9',
      userId: 'e007',
      role: 'sales_rep',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const badDecision = await fetch(`${baseUrl}/approvals/${record.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...MANAGER_HEADERS },
      body: JSON.stringify({ decision: 'maybe' }),
    });
    expect(badDecision.status).toBe(400);

    const missing = await fetch(`${baseUrl}/approvals/00000000-0000-0000-0000-000000000000`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...MANAGER_HEADERS },
      body: JSON.stringify({ decision: 'deny' }),
    });
    expect(missing.status).toBe(404);

    const anonymous = await fetch(`${baseUrl}/approvals`);
    expect(anonymous.status).toBe(401);
  });
});
