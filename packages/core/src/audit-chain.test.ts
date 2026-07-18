import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AuditEvent } from './audit.js';
import {
  generateAuditKeypair,
  parseSignedAuditLog,
  type SignedAuditEvent,
  SignedJsonlAuditLogger,
  verifyAuditChain,
} from './audit-chain.js';

function event(tool: string, decision: AuditEvent['decision'] = 'ALLOW'): AuditEvent {
  return {
    ts: '2026-07-18T00:00:00.000Z',
    userId: 'e007',
    role: 'sales_rep',
    system: 'twenty',
    tool,
    decision,
    latencyMs: 3,
    argsHash: 'abc123',
  };
}

async function tmpFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-audit-'));
  return join(dir, 'audit.jsonl');
}

/** 写 n 条记录、读回解析。 */
async function writeChain(n: number): Promise<{
  file: string;
  keys: ReturnType<typeof generateAuditKeypair>;
  records: SignedAuditEvent[];
}> {
  const file = await tmpFile();
  const keys = generateAuditKeypair();
  const logger = new SignedJsonlAuditLogger(file, keys.privateKey);
  for (let i = 0; i < n; i++) await logger.log(event(`tool_${i}`));
  const records = parseSignedAuditLog(await readFile(file, 'utf8'));
  return { file, keys, records };
}

describe('SignedJsonlAuditLogger + verifyAuditChain', () => {
  it('干净链：seq 从 1 单调、prevHash 链接、公钥全部验签通过', async () => {
    const { keys, records } = await writeChain(4);
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(records[0]?.prevHash).toBe('0'.repeat(64));
    for (let i = 1; i < records.length; i++) {
      expect(records[i]?.prevHash).toBe(records[i - 1]?.hash);
    }
    expect(verifyAuditChain(records, keys.publicKey)).toEqual({ ok: true, count: 4 });
  });

  it('篡改任一记录的业务字段 → 该记录 hash 复算不符，校验在此停下', async () => {
    const { keys, records } = await writeChain(4);
    // 攻击者改第 3 条的工具名（改数据但不动 hash/sig）
    const tampered = records.map((r, i) => (i === 2 ? { ...r, tool: 'get_salary' } : r));
    const result = verifyAuditChain(tampered, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.seq).toBe(3);
    expect(result.brokenAt?.reason).toContain('hash 不匹配');
  });

  it('攻击者改字段并重算 hash（但无私钥）→ 签名验不过', async () => {
    const { keys, records } = await writeChain(3);
    const { createHash } = await import('node:crypto');
    const victim = records[1] as SignedAuditEvent;
    const { seq, prevHash, hash: _h, sig, ...ev } = victim;
    const forgedEvent = { ...ev, tool: 'exfiltrate' };
    // 用与实现相同的规范化重算 hash，但没有私钥、只能沿用旧 sig
    const forgedHash = createHash('sha256')
      .update(canonical({ ...forgedEvent, seq, prevHash }))
      .digest('hex');
    const forged = records.map((r, i) =>
      i === 1 ? { ...forgedEvent, seq, prevHash, hash: forgedHash, sig } : r,
    );
    const result = verifyAuditChain(forged as SignedAuditEvent[], keys.publicKey);
    expect(result.ok).toBe(false);
    // hash 自洽（复算一致）但签名对不上 → 停在签名校验
    expect(result.brokenAt?.seq).toBe(2);
    expect(result.brokenAt?.reason).toContain('签名无效');
  });

  it('删除中间一条 → seq 跳号被抓', async () => {
    const { keys, records } = await writeChain(4);
    const dropped = records.filter((_, i) => i !== 1); // 删掉第 2 条：seq 变 1,3,4
    const result = verifyAuditChain(dropped, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.seq).toBe(3);
    expect(result.brokenAt?.reason).toContain('seq 不连续');
  });

  it('删除并重编号 seq 保持连续 → prevHash 仍断链（哈希链是真整性锚）', async () => {
    const { keys, records } = await writeChain(4);
    // 删掉第 2 条后把后面的 seq 补成 1,2,3——seq 检查过关，但 prevHash 对不上
    const renumbered = records.filter((_, i) => i !== 1).map((r, i) => ({ ...r, seq: i + 1 }));
    const result = verifyAuditChain(renumbered, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.seq).toBe(2);
    expect(result.brokenAt?.reason).toContain('prevHash 断链');
  });

  it('重排两条 → seq 不连续被抓', async () => {
    const { keys, records } = await writeChain(3);
    const swapped = [records[1], records[0], records[2]] as SignedAuditEvent[];
    const result = verifyAuditChain(swapped, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.reason).toContain('seq 不连续');
  });

  it('换一把公钥校验 → 首条即签名无效（公钥与签发私钥不符）', async () => {
    const { records } = await writeChain(2);
    const other = generateAuditKeypair();
    const result = verifyAuditChain(records, other.publicKey);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.seq).toBe(1);
    expect(result.brokenAt?.reason).toContain('签名无效');
  });

  it('新 logger 实例读旧文件后继续链（跨重启不断链）', async () => {
    const { file, keys } = await writeChain(2);
    // 模拟重启：新实例挂同一文件、同一私钥，再写两条
    const resumed = new SignedJsonlAuditLogger(file, keys.privateKey);
    await resumed.log(event('after_restart_1'));
    await resumed.log(event('after_restart_2'));
    const records = parseSignedAuditLog(await readFile(file, 'utf8'));
    expect(records.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(records[2]?.prevHash).toBe(records[1]?.hash); // 第 3 条接上第 2 条
    expect(verifyAuditChain(records, keys.publicKey)).toEqual({ ok: true, count: 4 });
  });

  it('末尾追加一条伪造记录（攻击者自造）→ 签名无效', async () => {
    const { file, keys, records } = await writeChain(2);
    const last = records[1] as SignedAuditEvent;
    // 攻击者不知私钥，编一条 prevHash 正确、sig 瞎填的记录追加进去
    const fake: SignedAuditEvent = {
      ...event('cover_tracks', 'ALLOW'),
      seq: 3,
      prevHash: last.hash,
      hash: 'f'.repeat(64),
      sig: Buffer.from('not-a-real-signature').toString('base64'),
    };
    await writeFile(file, `${await readFile(file, 'utf8')}${JSON.stringify(fake)}\n`);
    const all = parseSignedAuditLog(await readFile(file, 'utf8'));
    const result = verifyAuditChain(all, keys.publicKey);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.seq).toBe(3);
  });

  it('空日志校验通过（0 条记录）', () => {
    const keys = generateAuditKeypair();
    expect(verifyAuditChain([], keys.publicKey)).toEqual({ ok: true, count: 0 });
  });
});

/** 与实现相同的键排序规范化，供伪造测试复算 hash。 */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}
