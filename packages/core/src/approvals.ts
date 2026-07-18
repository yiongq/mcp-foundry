import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * 审批单：pending → approved/denied →（被一次调用消费）consumedAt。
 * 过期不是状态迁移而是惰性判定（expiresAt 已过即视为不存在），无需定时器。
 *
 * 注意与审计日志的差异：这里存 args 原文——续跑与审批人「看清在批什么」都离不开原文，
 * 这是审计侧只存 argsHash 刻意避开的保留面，因此该文件必须与 audit 同级对待（不进 git、不出容器卷）。
 */
export interface ApprovalRecord {
  id: string;
  system: string;
  tool: string;
  args: Record<string, unknown>;
  argsHash: string;
  /** 发起人（不是审批人）——续跑时按此身份重新走守卫管线 */
  userId: string;
  role: string;
  status: 'pending' | 'approved' | 'denied';
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  approverId?: string;
  consumedAt?: string;
  /** 入口层附加的上下文（如飞书回话 chatId，用于审批后把结果推回原对话） */
  meta?: Record<string, string>;
}

export interface ApprovalStore {
  /** 匹配同一发起人对同一工具同一参数的未消费、未过期单（幂等：重复调用不重复开单） */
  find(
    system: string,
    userId: string,
    tool: string,
    argsHash: string,
  ): Promise<ApprovalRecord | null>;
  get(id: string): Promise<ApprovalRecord | null>;
  create(
    record: Omit<ApprovalRecord, 'id' | 'status' | 'createdAt'> & { meta?: Record<string, string> },
  ): Promise<ApprovalRecord>;
  decide(id: string, status: 'approved' | 'denied', approverId: string): Promise<ApprovalRecord>;
  /** 消费一张已决单：同一张单只放行/拒绝一次，防重放 */
  consume(id: string): Promise<ApprovalRecord>;
  /** 入口层补充上下文（如创建后才知道的会话 id） */
  annotate(id: string, meta: Record<string, string>): Promise<ApprovalRecord>;
  listPending(): Promise<ApprovalRecord[]>;
}

function isOpen(record: ApprovalRecord, now: Date): boolean {
  return record.consumedAt === undefined && new Date(record.expiresAt) > now;
}

/**
 * find() 的择优：已决单（approved/denied）优先于 pending——否则并发开出的重复单里，
 * 一张已批准的旧单会被更新的 pending 单挤掉、迟迟消费不掉，最终变成一张长期悬挂的
 * 已批准单（下次同参调用会无新批复直接执行）。同类中取较新的。
 */
function preferOver(candidate: ApprovalRecord, current: ApprovalRecord): boolean {
  const decided = (r: ApprovalRecord): number => (r.status === 'pending' ? 0 : 1);
  if (decided(candidate) !== decided(current)) return decided(candidate) > decided(current);
  return candidate.createdAt > current.createdAt;
}

/** 内存实现，供测试/评测；也是 JSONL 实现回放后的内核 */
export class MemoryApprovalStore implements ApprovalStore {
  protected readonly records = new Map<string, ApprovalRecord>();

  async find(
    system: string,
    userId: string,
    tool: string,
    argsHash: string,
  ): Promise<ApprovalRecord | null> {
    const now = new Date();
    let best: ApprovalRecord | null = null;
    for (const record of this.records.values()) {
      if (
        record.system === system &&
        record.userId === userId &&
        record.tool === tool &&
        record.argsHash === argsHash &&
        isOpen(record, now) &&
        (best === null || preferOver(record, best))
      ) {
        best = record;
      }
    }
    return best;
  }

  async get(id: string): Promise<ApprovalRecord | null> {
    return this.records.get(id) ?? null;
  }

  // 写前持久化（预写日志）：先落盘事件、成功后再改内存。持久化失败则内存不变、抛错——
  // 内存与磁盘不会分叉（旧序是先改内存后落盘，落盘失败留下「内存已生效、盘上没记」的
  // 假象，重启后凭空回退，同一单可被二次批复/二次执行）。

  async create(
    input: Omit<ApprovalRecord, 'id' | 'status' | 'createdAt'>,
  ): Promise<ApprovalRecord> {
    const record: ApprovalRecord = {
      ...input,
      id: randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    await this.persist({ type: 'created', record });
    this.records.set(record.id, record);
    return record;
  }

  async decide(
    id: string,
    status: 'approved' | 'denied',
    approverId: string,
  ): Promise<ApprovalRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`审批单不存在：${id}`);
    if (record.status !== 'pending') throw new Error(`审批单已是 ${record.status}，不能重复批复`);
    if (!isOpen(record, new Date())) throw new Error('审批单已过期');
    const decidedAt = new Date().toISOString();
    await this.persist({ type: 'decided', id, status, approverId, decidedAt });
    record.status = status;
    record.approverId = approverId;
    record.decidedAt = decidedAt;
    return record;
  }

  async consume(id: string): Promise<ApprovalRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`审批单不存在：${id}`);
    if (record.consumedAt !== undefined) throw new Error('审批单已被消费');
    const consumedAt = new Date().toISOString();
    await this.persist({ type: 'consumed', id, consumedAt });
    record.consumedAt = consumedAt;
    return record;
  }

  async annotate(id: string, meta: Record<string, string>): Promise<ApprovalRecord> {
    const record = this.records.get(id);
    if (!record) throw new Error(`审批单不存在：${id}`);
    await this.persist({ type: 'annotated', id, meta });
    record.meta = { ...record.meta, ...meta };
    return record;
  }

  async listPending(): Promise<ApprovalRecord[]> {
    const now = new Date();
    return [...this.records.values()]
      .filter((r) => r.status === 'pending' && isOpen(r, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /** 子类挂持久化钩子；内存实现为空 */
  protected async persist(_event: ApprovalEvent): Promise<void> {}
}

type ApprovalEvent =
  | { type: 'created'; record: ApprovalRecord }
  | {
      type: 'decided';
      id: string;
      status: 'approved' | 'denied';
      approverId: string;
      decidedAt: string;
    }
  | { type: 'consumed'; id: string; consumedAt: string }
  | { type: 'annotated'; id: string; meta: Record<string, string> };

/**
 * JSONL 事件溯源实现：每次状态迁移追加一行，启动时回放重建内存态。
 * 与 JsonlAuditLogger 同一个持久化姿势——零新依赖，文件放审计卷即可跨重启存活。
 */
export class JsonlApprovalStore extends MemoryApprovalStore {
  private ready: Promise<void> | null = null;

  constructor(private readonly filePath: string) {
    super();
  }

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
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]?.trim();
      if (line === undefined || line === '') continue;
      let event: ApprovalEvent;
      try {
        event = JSON.parse(line) as ApprovalEvent;
      } catch (err) {
        // 只容忍最后一行的半截写入（进程在 appendFile 中途被杀留下的残行）——
        // 直接跳过、不让整个存储卡死（否则涉审调用全 fail-closed 到手工修文件为止）。
        // 非末行解析失败是真实损坏，照抛不误。
        const isLastContentLine = lines.slice(i + 1).every((l) => l.trim() === '');
        if (isLastContentLine) {
          console.warn(`[approvals] 跳过末尾半截记录（疑似崩溃残留）：${this.filePath}`);
          break;
        }
        throw err;
      }
      this.replay(event);
    }
  }

  private replay(event: ApprovalEvent): void {
    if (event.type === 'created') {
      this.records.set(event.record.id, { ...event.record });
      return;
    }
    const record = this.records.get(event.id);
    if (!record) return; // 半截日志（如手工清理过）按缺失处理，不炸启动
    if (event.type === 'decided') {
      record.status = event.status;
      record.approverId = event.approverId;
      record.decidedAt = event.decidedAt;
    } else if (event.type === 'consumed') {
      record.consumedAt = event.consumedAt;
    } else {
      record.meta = { ...record.meta, ...event.meta };
    }
  }

  protected override async persist(event: ApprovalEvent): Promise<void> {
    await appendFile(this.filePath, `${JSON.stringify(event)}\n`, 'utf8');
  }

  override async find(
    system: string,
    userId: string,
    tool: string,
    argsHash: string,
  ): Promise<ApprovalRecord | null> {
    await this.ensureLoaded();
    return super.find(system, userId, tool, argsHash);
  }

  override async get(id: string): Promise<ApprovalRecord | null> {
    await this.ensureLoaded();
    return super.get(id);
  }

  override async create(
    input: Omit<ApprovalRecord, 'id' | 'status' | 'createdAt'>,
  ): Promise<ApprovalRecord> {
    await this.ensureLoaded();
    return super.create(input);
  }

  override async decide(
    id: string,
    status: 'approved' | 'denied',
    approverId: string,
  ): Promise<ApprovalRecord> {
    await this.ensureLoaded();
    return super.decide(id, status, approverId);
  }

  override async consume(id: string): Promise<ApprovalRecord> {
    await this.ensureLoaded();
    return super.consume(id);
  }

  override async annotate(id: string, meta: Record<string, string>): Promise<ApprovalRecord> {
    await this.ensureLoaded();
    return super.annotate(id, meta);
  }

  override async listPending(): Promise<ApprovalRecord[]> {
    await this.ensureLoaded();
    return super.listPending();
  }
}
