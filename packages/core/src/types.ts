import type { z } from 'zod';

/**
 * 提问人身份。userId 由入口层（飞书事件 / demo header）提供，Foundry 内部不做认证。
 *
 * 角色是**按系统**解析的：一个人可以在不同系统里有不同角色（HR 的 hr_admin +
 * CRM 的 sales_manager）。`rolesBySystem` 是按系统的覆盖，`role` 是缺省/兜底——
 * 守卫针对目标系统取 `rolesBySystem[system] ?? role`（见 roleForSystem）。
 * 只填 `role`（不填 rolesBySystem）= 单角色全局，与旧行为完全一致。
 */
export interface Principal {
  userId: string;
  role: string;
  /** 按系统覆盖角色，如 { orangehrm: 'hr_admin', twenty: 'sales_manager' }。缺省回落到 role。 */
  rolesBySystem?: Record<string, string>;
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
  /**
   * 可选：对「改写已存在行」的写工具，返回该调用将影响的现有行（前像），
   * 供守卫在 execute 之前对前像跑行级归属校验——行级过滤跑在结果上，
   * 拦得住读的泄漏，却拦不住已发生的写。返回 undefined 表示本工具无需前置校验
   * （读工具、或 create 这类归属由自身盖戳的写工具）；返回 null 表示目标不存在。
   * 不实现此方法 = 该系统没有需要前置归属校验的写工具。
   */
  preimage?(call: ToolCall): Promise<unknown>;
  /**
   * 可选：为分级审批提供「参数之外」的信号（如"本月已退款几笔"）。
   * 守卫把返回值并入审批条件的求值上下文（ctx = 调用参数 ∪ 信号），
   * 于是 rbac 里的 `when: { field: refundCountThisMonth, gte: 2 }` 能引用它。
   * 无此方法或返回空 = 分级只看调用参数本身。
   */
  approvalSignals?(call: ToolCall, principal: Principal): Promise<Record<string, number>>;
}

export interface AdapterResult {
  data: unknown;
}

export type RefusalReason = 'unknown_role' | 'tool_not_allowed' | 'row_denied' | 'approval_denied';

/**
 * 守卫管线的出口类型。
 * 拒答分支（refusal）没有 data 字段——结构上不可能夹带业务数据或模型文本。
 * pending 分支同理：只带单号与规则指针，审批中的调用不存在任何业务数据可泄。
 */
export type GuardedResult =
  | { kind: 'ok'; data: unknown; maskedFields: string[] }
  | { kind: 'refusal'; reason: RefusalReason; rule: string }
  | { kind: 'pending'; reason: 'approval_required'; approvalId: string; rule: string }
  | { kind: 'error'; message: string };
