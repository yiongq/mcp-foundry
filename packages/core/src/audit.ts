import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEvent {
  ts: string;
  userId: string;
  role: string;
  system: string;
  tool: string;
  decision: 'ALLOW' | 'DENY' | 'PENDING' | 'ERROR';
  reason?: string;
  rule?: string;
  latencyMs: number;
  /** 只记参数摘要不记原文——审计日志本身不能变成第二个泄漏面 */
  argsHash: string;
  /** 审批决策事件专用：把「谁批准/驳回了哪张高危单」写进签名链，
   * 让防篡改审计能回答「这笔退款谁批的」，也让审批记录不再只存在未签名的 approvals.jsonl。
   * 普通操作事件不带这两个字段；canonicalJson 丢弃 undefined，故老记录 hash 不变。 */
  approvalId?: string;
  approverId?: string;
}

export interface AuditLogger {
  log(event: AuditEvent): void | Promise<void>;
}

/**
 * 参数摘要用规范化 JSON（键递归排序）——否则同一组参数因键序不同（LLM 复述时
 * 常见）会得到不同哈希，让审批闸门的「同参重试消票」错过已批准的单、重复开单。
 * 仅产出摘要，键序归一对审计与审批匹配都只增稳定性。
 */
export function hashArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(canonicalJson(args)).digest('hex').slice(0, 16);
}

/**
 * 键递归排序的规范化 JSON——同一份数据无论键序都得到同一串字节。
 * 审计哈希链据此计算每条记录的 hash：验证方无需知道写入时的键序也能复算。
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

export class JsonlAuditLogger implements AuditLogger {
  private dirReady: Promise<void> | null = null;

  constructor(private readonly filePath: string) {}

  async log(event: AuditEvent): Promise<void> {
    this.dirReady ??= mkdir(dirname(this.filePath), { recursive: true }).then(() => undefined);
    await this.dirReady;
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

/** 测试与评测用 */
export class MemoryAuditLogger implements AuditLogger {
  readonly events: AuditEvent[] = [];

  log(event: AuditEvent): void {
    this.events.push(event);
  }
}
