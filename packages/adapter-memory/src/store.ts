/**
 * 跨会话记忆行。字段名刻意与业务系统同用 snake_case 的 employee_id——
 * RBAC 行级规则（employee_id == $self.userId）对业务数据和记忆一体生效，
 * 不需要为记忆单独发明一套过滤机制。
 */
export interface MemoryRow {
  memory_id: string;
  /** 归属人。写入时由适配器从 principal 盖戳，不接受参数指定。 */
  employee_id: string;
  content: string;
  /** 写入时所在会话；召回默认跨会话（这正是「记忆」区别于「上下文」的点） */
  session_id: string;
  created_at: string;
}

/** 进程内记忆存储。评测每题各建一个，保证用例互不串数据。 */
export class MemoryStore {
  private readonly rows: MemoryRow[] = [];
  private seq = 0;

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  save(ownerId: string, content: string, sessionId: string): MemoryRow {
    this.seq += 1;
    const row: MemoryRow = {
      memory_id: `m${String(this.seq).padStart(3, '0')}`,
      employee_id: ownerId,
      content,
      session_id: sessionId,
      created_at: this.now(),
    };
    this.rows.push(row);
    return row;
  }

  /**
   * 返回所有匹配行，不看提问人是谁——归属过滤统一由守卫行级规则收口。
   * query 是内容子串匹配（结构化匹配，无表达式求值，不构成注入面）。
   */
  recall(query?: string, sessionId?: string): MemoryRow[] {
    return this.rows.filter(
      (row) =>
        (query === undefined || row.content.includes(query)) &&
        (sessionId === undefined || row.session_id === sessionId),
    );
  }

  get(memoryId: string): MemoryRow | null {
    return this.rows.find((row) => row.memory_id === memoryId) ?? null;
  }
}
