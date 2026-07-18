import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Principal } from './types.js';

/**
 * 按目标系统解析角色：一个人可在不同系统里有不同角色（HR 的 hr_admin + CRM 的
 * sales_manager）。`rolesBySystem[system]` 优先，缺省回落到 `role`——只填 role
 * （单角色全局）与旧行为完全一致。
 */
export function roleForSystem(principal: Principal, system: string): string {
  return principal.rolesBySystem?.[system] ?? principal.role;
}

/** 返回一个「role 已按目标系统解析好」的 principal，供守卫下游统一使用（无覆盖则原样返回）。 */
export function withSystemRole(principal: Principal, system: string): Principal {
  const role = roleForSystem(principal, system);
  return role === principal.role ? principal : { ...principal, role };
}

/**
 * 行级规则：结果集中每一行的 field 必须等于 equals 解出的值。
 * equals 支持 "$self.userId" / "$self.attrs.<key>" 引用提问人，或字面量。
 * 刻意不做表达式 DSL——可求值字符串是注入面，结构化对象不是。
 */
const rowRuleSchema = z.object({
  field: z.string().min(1),
  equals: z.union([z.string(), z.number()]),
});

/**
 * 分级审批条件：对「调用参数 + 适配器算出的信号」求值成 true 即需人工审批。
 * 结构化比较，刻意不做可求值 DSL（同 rowRule：可求值字符串是注入面）。
 * 数值比较遇缺失/非数值一律判 true——fail-safe，宁可多要一次审批，不可静默放行。
 */
export type ApprovalCondition =
  | { field: string; gt: number }
  | { field: string; gte: number }
  | { field: string; lt: number }
  | { field: string; lte: number }
  | { anyOf: ApprovalCondition[] }
  | { allOf: ApprovalCondition[] };

const approvalConditionSchema: z.ZodType<ApprovalCondition> = z.lazy(() =>
  z.union([
    z.object({ field: z.string().min(1), gt: z.number() }).strict(),
    z.object({ field: z.string().min(1), gte: z.number() }).strict(),
    z.object({ field: z.string().min(1), lt: z.number() }).strict(),
    z.object({ field: z.string().min(1), lte: z.number() }).strict(),
    z.object({ anyOf: z.array(approvalConditionSchema).min(1) }).strict(),
    z.object({ allOf: z.array(approvalConditionSchema).min(1) }).strict(),
  ]),
);

/** 审批条目：字符串=该工具一律涉审；{tool, when}=分级，when 成立才涉审。 */
const approvalEntrySchema = z.union([
  z.string().min(1),
  z.object({ tool: z.string().min(1), when: approvalConditionSchema }).strict(),
]);

const roleRuleSchema = z.object({
  tools: z.union([z.literal('*'), z.array(z.string().min(1))]),
  rows: z.array(rowRuleSchema).default([]),
  mask: z.array(z.string().min(1)).default([]),
  /**
   * 该角色调用这些工具须先经人工审批（与 tools 白名单独立：先过白名单，再过闸门）。
   * 条目可为纯工具名（一律涉审）或 {tool, when}（分级——when 对参数+信号成立才涉审），
   * 后者即 policy-as-code 的「allow / needs-approval」分级放行（如退款按金额/频次分档）。
   */
  approval: z.array(approvalEntrySchema).default([]),
  /** 该角色是否有权批复本域的审批单（在卡片/接口回调时校验点按人身份用） */
  approver: z.boolean().default(false),
});

const rbacConfigSchema = z.object({
  roles: z.record(z.string().min(1), roleRuleSchema),
});

export type RowRule = z.infer<typeof rowRuleSchema>;
export type ApprovalEntry = z.infer<typeof approvalEntrySchema>;
export type RoleRule = z.infer<typeof roleRuleSchema>;
export type RbacConfig = z.infer<typeof rbacConfigSchema>;

export function loadRbacConfig(yamlText: string): RbacConfig {
  return rbacConfigSchema.parse(parseYaml(yamlText));
}

/** 对上下文（调用参数 + 适配器信号）求值一个审批条件。数值缺失/非数值 → true（fail-safe）。 */
export function evalApprovalCondition(
  cond: ApprovalCondition,
  ctx: Record<string, unknown>,
): boolean {
  if ('anyOf' in cond) return cond.anyOf.some((c) => evalApprovalCondition(c, ctx));
  if ('allOf' in cond) return cond.allOf.every((c) => evalApprovalCondition(c, ctx));
  const raw = ctx[cond.field];
  const actual = typeof raw === 'number' ? raw : Number(raw);
  // 缺失/非数值：宁可判「需审批」也不静默放行（金额字段被漏传/塞成非数不应免审）
  if (!Number.isFinite(actual)) return true;
  if ('gt' in cond) return actual > cond.gt;
  if ('gte' in cond) return actual >= cond.gte;
  if ('lt' in cond) return actual < cond.lt;
  return actual <= cond.lte;
}

/**
 * 该角色调用该工具（在给定上下文下）是否需要人工审批。
 * 纯工具名条目 = 一律涉审；{tool, when} 条目 = when 对 ctx 成立才涉审。
 * ctx = 调用参数 ∪ 适配器算出的信号（如 refundCountThisMonth）。
 */
export function roleRequiresApproval(
  role: RoleRule,
  tool: string,
  ctx: Record<string, unknown>,
): boolean {
  for (const entry of role.approval) {
    if (typeof entry === 'string') {
      if (entry === tool) return true;
    } else if (entry.tool === tool && evalApprovalCondition(entry.when, ctx)) {
      return true;
    }
  }
  return false;
}

/** 该角色是否对该工具配置了任一审批条目（决定守卫要不要去取分级信号）。 */
export function roleHasApprovalRule(role: RoleRule, tool: string): boolean {
  return role.approval.some((e) => (typeof e === 'string' ? e === tool : e.tool === tool));
}

/** 解析 equals 里的 $self 引用；解析失败返回 undefined（守卫侧按拒绝处理，不静默放行）。 */
export function resolveSelfRef(
  value: string | number,
  principal: Principal,
): string | number | undefined {
  if (typeof value === 'number') return value;
  if (!value.startsWith('$self.')) return value;
  if (value === '$self.userId') return principal.userId;
  const attrKey = value.startsWith('$self.attrs.') ? value.slice('$self.attrs.'.length) : null;
  if (attrKey) return principal.attrs?.[attrKey];
  return undefined;
}
