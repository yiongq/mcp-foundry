import { createHash, generateKeyPairSync, type KeyObject, sign, verify } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { type AuditEvent, type AuditLogger, canonicalJson } from './audit.js';

/**
 * 防篡改审计：把审计日志从「普通追加 JSONL」升级为「Ed25519 签名的哈希链」。
 *
 * 每条记录带 seq（单调）、prevHash（前一条的 hash）、hash（本条规范化内容的 SHA-256）、
 * sig（对 hash 的 Ed25519 签名）。两层保护：
 *   - 哈希链：改动任一历史记录会改变它的 hash → 断掉后续记录的 prevHash 链 → 复算即暴露
 *   - 签名：能写文件的攻击者也无法在改动后重算出合法签名（私钥不在服务器上）
 * 校验只需公钥，可离线进行（verifyAuditChain / verify-audit CLI）。
 *
 * 私钥属签发方、绝不落服务器；服务器只持有它签发的记录。与「JWKS 身份」同一条纪律：
 * 服务器能生产可验证的事实，却无法伪造历史。
 */

const GENESIS = '0'.repeat(64);

export interface SignedAuditEvent extends AuditEvent {
  /** 单调序号，从 1 起（创世记录 prevHash 为全 0） */
  seq: number;
  /** 前一条记录的 hash（链接点） */
  prevHash: string;
  /** 本条 = sha256hex(canonicalJson({...event, seq, prevHash})) */
  hash: string;
  /** 对 hash 字节的 Ed25519 签名，base64 */
  sig: string;
}

/** hash 覆盖业务字段 + seq + prevHash——三者任一改动都会让复算的 hash 不同。 */
function computeHash(event: AuditEvent, seq: number, prevHash: string): string {
  return createHash('sha256')
    .update(canonicalJson({ ...event, seq, prevHash }))
    .digest('hex');
}

/** 生成审计签名密钥对（Ed25519）。私钥交签发方保管，公钥随日志分发给校验方。 */
export function generateAuditKeypair(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync('ed25519');
}

/**
 * 签名哈希链审计日志。写入顺序严格串行（seq/prevHash 必须无竞态），
 * 写前算签、追加成功后才推进链头——落盘失败则 seq/prevHash 不前进、抛错，
 * 内存态与盘上不分叉（同 JsonlApprovalStore 的预写纪律）。
 */
export class SignedJsonlAuditLogger implements AuditLogger {
  private ready: Promise<void> | null = null;
  /** 串行队列：每条 log 等上一条彻底落盘，保证 seq/prevHash 无竞态 */
  private tail: Promise<void> = Promise.resolve();
  private seq = 0;
  private prevHash = GENESIS;

  constructor(
    private readonly filePath: string,
    private readonly privateKey: KeyObject,
  ) {}

  async log(event: AuditEvent): Promise<void> {
    const run = this.tail.then(() => this.appendOne(event));
    // 队列不能因单条失败而永久卡死：吞掉 rejection 只为让下一条继续（用未推进的 prevHash）；
    // 本次调用仍拿到原始 rejection（下面 return run），错误不被吞。
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async appendOne(event: AuditEvent): Promise<void> {
    await this.ensureLoaded();
    const seq = this.seq + 1;
    const prevHash = this.prevHash;
    const hash = computeHash(event, seq, prevHash);
    const sig = sign(null, Buffer.from(hash, 'hex'), this.privateKey).toString('base64');
    const record: SignedAuditEvent = { ...event, seq, prevHash, hash, sig };
    // 落盘可能抛（磁盘满/权限）——抛出时下面两行不执行，链头不前进
    await appendFile(this.filePath, `${JSON.stringify(record)}\n`, 'utf8');
    this.seq = seq;
    this.prevHash = hash;
  }

  /** 启动时读取现有日志尾部，从最后一条记录继续链（跨重启链不断） */
  private async ensureLoaded(): Promise<void> {
    this.ready ??= this.load();
    await this.ready;
  }

  private async load(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    const lines = text.split('\n').filter((l) => l.trim() !== '');
    const last = lines.at(-1);
    if (last === undefined) return;
    // 只读尾部续链；完整性由校验器负责（篡改过的尾部会让后续校验失败，这是对的）
    const record = JSON.parse(last) as SignedAuditEvent;
    this.seq = record.seq;
    this.prevHash = record.hash;
  }
}

export interface VerifyResult {
  ok: boolean;
  count: number;
  /** 第一处断裂：序号 + 原因（ok=true 时不存在） */
  brokenAt?: { seq: number; reason: string };
}

/**
 * 离线校验一条签名哈希链：逐条查 seq 连续、prevHash 链接、hash 复算一致、签名有效。
 * 任一处失败即在该记录停下并报因——把「日志没被动过」变成一个可复现的密码学事实。
 */
export function verifyAuditChain(
  records: readonly SignedAuditEvent[],
  publicKey: KeyObject,
): VerifyResult {
  let prevHash = GENESIS;
  let expectedSeq = 1;
  for (const record of records) {
    const broken = (reason: string): VerifyResult => ({
      ok: false,
      count: records.length,
      brokenAt: { seq: record.seq, reason },
    });
    if (record.seq !== expectedSeq)
      return broken(`seq 不连续（期望 ${expectedSeq}，实际 ${record.seq}）`);
    if (record.prevHash !== prevHash) return broken('prevHash 断链（记录被删除、重排或插入）');
    const { seq, prevHash: recPrev, hash, sig, ...event } = record;
    if (computeHash(event as AuditEvent, seq, recPrev) !== hash) {
      return broken('hash 不匹配（记录字段被篡改）');
    }
    let sigOk = false;
    try {
      sigOk = verify(null, Buffer.from(hash, 'hex'), publicKey, Buffer.from(sig, 'base64'));
    } catch {
      sigOk = false;
    }
    if (!sigOk) return broken('签名无效（伪造，或公钥与签发私钥不符）');
    prevHash = hash;
    expectedSeq += 1;
  }
  return { ok: true, count: records.length };
}

/** 解析 JSONL 审计文件为签名记录数组（跳过空行）。 */
export function parseSignedAuditLog(text: string): SignedAuditEvent[] {
  return text
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as SignedAuditEvent);
}
