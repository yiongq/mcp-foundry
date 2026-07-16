import { createHash } from 'node:crypto';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface AuditEvent {
  ts: string;
  userId: string;
  role: string;
  system: string;
  tool: string;
  decision: 'ALLOW' | 'DENY' | 'ERROR';
  reason?: string;
  rule?: string;
  latencyMs: number;
  /** 只记参数摘要不记原文——审计日志本身不能变成第二个泄漏面 */
  argsHash: string;
}

export interface AuditLogger {
  log(event: AuditEvent): void | Promise<void>;
}

export function hashArgs(args: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(args)).digest('hex').slice(0, 16);
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
