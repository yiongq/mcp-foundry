/**
 * 防篡改签名审计的**部署组合**端到端：真 SignedJsonlAuditLogger 挂进真 HTTP 服务器，
 * 驱动 allow/deny/pending 三类调用，再从校验方视角（只拿公钥 + 日志文件）确认整条链自洽、
 * 手改一条即断链，并跑真正的 verify-audit CLI 子进程。audit-chain.test.ts 覆盖链算法本身，
 * 这里补的是「私钥 → 服务器 → JSONL 文件 → verify-audit」这条此前无人断言的部署接线。
 */
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRbacConfig,
  MemoryApprovalStore,
  parseSignedAuditLog,
  SignedJsonlAuditLogger,
  type SystemAdapter,
  verifyAuditChain,
} from '@yiong/foundry-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFoundryServer } from './server.js';

// 三个工具：sales_rep 白名单只含 list_contacts / delete_contact；export_all 存在但不在白名单
// （用来触发 tool_not_allowed → DENY 审计），delete_contact 需审批（触发 PENDING）。
const fakeCrm: SystemAdapter = {
  system: 'fake-crm',
  tools: () => [
    { name: 'list_contacts', description: '列联系人', inputSchema: z.object({}) },
    { name: 'delete_contact', description: '删联系人', inputSchema: z.object({ id: z.string() }) },
    { name: 'export_all', description: '导出全部', inputSchema: z.object({}) },
  ],
  execute: async () => ({ data: { done: true } }),
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

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
let server: Server;
let baseUrl: string;
let auditPath: string;
let pubPath: string;

const REP = { 'x-foundry-user': 'e007', 'x-foundry-role': 'sales_rep' };

async function callTool(tool: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...REP,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    }),
  });
  const body = (await res.json()) as { result?: { content: Array<{ text: string }> } };
  return body.result?.content[0]?.text ?? '';
}

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-signed-audit-'));
  auditPath = join(dir, 'foundry.jsonl');
  pubPath = join(dir, 'audit-ed25519.pub');
  writeFileSync(pubPath, publicKey.export({ type: 'spki', format: 'pem' }));

  server = createFoundryServer({
    systems: [{ adapter: fakeCrm, rbac }],
    audit: new SignedJsonlAuditLogger(auditPath, privateKey),
    approvals: new MemoryApprovalStore(),
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  baseUrl = `http://127.0.0.1:${address.port}`;

  // 顺序驱动三类调用（各自 await → 审计行落盘后响应才返回）
  await callTool('list_contacts', {}); // ALLOW
  await callTool('export_all', {}); // 存在但未授权 → 拦截记 DENY
  const pending = await callTool('delete_contact', { id: 'c1' }); // 需审批 → PENDING
  expect(JSON.parse(pending).kind).toBe('pending');
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('签名审计链：真服务器 → JSONL 文件 → 校验方（只用公钥）', () => {
  it('三类调用都落了签名审计，整条链自洽', () => {
    const records = parseSignedAuditLog(readFileSync(auditPath, 'utf8'));
    expect(records.length).toBeGreaterThanOrEqual(3);
    const decisions = records.map((r) => r.decision);
    expect(decisions).toContain('ALLOW');
    expect(decisions).toContain('DENY');
    expect(decisions).toContain('PENDING');

    const good = verifyAuditChain(records, publicKey);
    expect(good.ok).toBe(true);
    expect(good.count).toBe(records.length);
  });

  it('手改一条记录 → 校验断链（seq 0 处）', () => {
    const lines = readFileSync(auditPath, 'utf8').trimEnd().split('\n');
    const firstLine = lines[0];
    if (firstLine === undefined) throw new Error('审计文件为空');
    const first = JSON.parse(firstLine) as Record<string, unknown>;
    const firstSeq = first.seq; // 断链应恰好定位到被改的这条
    first.userId = 'e999-tampered'; // 改一个被哈希覆盖的字段
    lines[0] = JSON.stringify(first);

    const bad = verifyAuditChain(parseSignedAuditLog(lines.join('\n')), publicKey);
    expect(bad.ok).toBe(false);
    expect(bad.brokenAt?.seq).toBe(firstSeq);
  });

  it('verify-audit CLI 子进程：真文件 exit 0；篡改副本 exit 1', () => {
    const bin = fileURLToPath(new URL('../bin/verify-audit.ts', import.meta.url));

    // 真文件：链完整 → exit 0，stdout 含「审计链完整」
    const out = execFileSync(
      'node',
      ['--import', 'tsx', bin, '--file', auditPath, '--pubkey', pubPath],
      { encoding: 'utf8' },
    );
    expect(out).toContain('审计链完整');

    // 篡改副本：删掉最后一行的一个字符 → 断链 → exit 1
    const tamperedPath = `${auditPath}.tampered`;
    const raw = readFileSync(auditPath, 'utf8');
    writeFileSync(tamperedPath, raw.replace(/"sig":"./, '"sig":"X'));
    expect(() =>
      execFileSync('node', ['--import', 'tsx', bin, '--file', tamperedPath, '--pubkey', pubPath], {
        encoding: 'utf8',
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});
