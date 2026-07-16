import type { z } from 'zod';

/** 提问人身份。userId 由入口层（飞书事件 / demo header）提供，Foundry 内部不做认证。 */
export interface Principal {
  userId: string;
  role: string;
  attrs?: Record<string, string | number>;
}

export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: z.ZodType;
}

export interface ToolCall {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * 适配器只负责「接得通」，不做任何权限判断——权限统一收口在守卫管线。
 * principal 仅供写入类工具盖归属戳（如记忆的 owner 取自身份透传而非参数，
 * 参数伪造不了归属）；适配器不得据此做放行/拒绝决策。
 */
export interface SystemAdapter {
  /** 系统标识，进审计日志，如 "orangehrm" */
  readonly system: string;
  tools(): ToolSpec[];
  execute(call: ToolCall, principal: Principal): Promise<AdapterResult>;
}

export interface AdapterResult {
  data: unknown;
}

export type RefusalReason = 'unknown_role' | 'tool_not_allowed' | 'row_denied';

/**
 * 守卫管线的出口类型。
 * 拒答分支（refusal）没有 data 字段——结构上不可能夹带业务数据或模型文本。
 */
export type GuardedResult =
  | { kind: 'ok'; data: unknown; maskedFields: string[] }
  | { kind: 'refusal'; reason: RefusalReason; rule: string }
  | { kind: 'error'; message: string };
