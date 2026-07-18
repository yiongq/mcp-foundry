import type { ApprovalStore } from './approvals.js';
import { type AuditLogger, hashArgs } from './audit.js';
import {
  type RbacConfig,
  type RowRule,
  resolveSelfRef,
  roleHasApprovalRule,
  roleRequiresApproval,
  withSystemRole,
} from './rbac.js';
import type { GuardedResult, Principal, SystemAdapter, ToolCall, ToolSpec } from './types.js';

/** 守卫的三道防线，评测 ablation 按此粒度逐层关闭以量化每层贡献。 */
export type GuardLayer = 'rbac' | 'row_filter' | 'field_mask';

/** 审批单默认有效期：足够审批人「几小时后才看到」，又不至于攒出一堆过期僵尸单 */
const DEFAULT_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export interface GuardOptions {
  /**
   * 仅供评测 ablation（守卫开/关对照实验）使用——生产路径永远全开。
   * 'rbac' 同时涵盖角色查找与工具白名单两个检查。
   */
  disabledLayers?: readonly GuardLayer[];
  /** 审批闸门的单据存储。角色配置了 approval 列表却没接存储时，涉审调用一律报错（fail-closed）。 */
  approvals?: ApprovalStore;
  approvalTtlMs?: number;
}

/**
 * 守卫管线，权限的唯一收口：
 *   角色查找 → 工具白名单 → 适配器执行 → 行级过滤 → 字段脱敏 → 审计
 * 任何一步失败都走结构化拒答/错误分支，且两类分支都不携带业务数据。
 */
export class Guard {
  private readonly disabled: ReadonlySet<GuardLayer>;
  private readonly approvals: ApprovalStore | undefined;
  private readonly approvalTtlMs: number;

  constructor(
    private readonly rbac: RbacConfig,
    private readonly audit: AuditLogger,
    options: GuardOptions = {},
  ) {
    this.disabled = new Set(options.disabledLayers ?? []);
    this.approvals = options.approvals;
    this.approvalTtlMs = options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS;
  }

  /** tools/list 阶段就按角色收窄——不该用的工具连列表里都不出现 */
  allowedTools(adapter: SystemAdapter, rawPrincipal: Principal): ToolSpec[] {
    // 按目标系统解析角色（多帽子：同一人在不同系统可有不同角色）
    const principal = withSystemRole(rawPrincipal, adapter.system);
    if (this.disabled.has('rbac')) return adapter.tools();
    const role = this.rbac.roles[principal.role];
    if (!role) return [];
    if (role.tools === '*') return adapter.tools();
    const allowed = new Set(role.tools);
    return adapter.tools().filter((t) => allowed.has(t.name));
  }

  async invoke(
    adapter: SystemAdapter,
    rawPrincipal: Principal,
    call: ToolCall,
  ): Promise<GuardedResult> {
    // 按目标系统解析角色（多帽子：同一人在不同系统可有不同角色）；下游统一用 principal
    const principal = withSystemRole(rawPrincipal, adapter.system);
    const startedAt = performance.now();
    const done = async (result: GuardedResult): Promise<GuardedResult> => {
      await this.audit.log({
        ts: new Date().toISOString(),
        userId: principal.userId,
        role: principal.role,
        system: adapter.system,
        tool: call.tool,
        decision:
          result.kind === 'ok'
            ? 'ALLOW'
            : result.kind === 'refusal'
              ? 'DENY'
              : result.kind === 'pending'
                ? 'PENDING'
                : 'ERROR',
        ...(result.kind === 'refusal' || result.kind === 'pending'
          ? { reason: result.reason, rule: result.rule }
          : {}),
        latencyMs: Math.round(performance.now() - startedAt),
        argsHash: hashArgs(call.args),
      });
      return result;
    };

    const role = this.rbac.roles[principal.role];
    if (!this.disabled.has('rbac')) {
      if (!role) {
        return done({ kind: 'refusal', reason: 'unknown_role', rule: `role:${principal.role}` });
      }
      if (role.tools !== '*' && !role.tools.includes(call.tool)) {
        return done({
          kind: 'refusal',
          reason: 'tool_not_allowed',
          rule: `tools:${principal.role}`,
        });
      }
    }

    // 写工具的行级归属前置校验：行级过滤跑在 execute 的结果上，能拦读的泄漏，
    // 却拦不住已发生的写（删了同事的行再判权 = 数据已丢、审计还记成 DENY）。
    // 对「改写已存在行」的写工具，先取前像跑同一套行级规则；不匹配即在 execute
    // 前拒绝，且发生在审批之前——不该由他动的行，连审批单都不该开。
    // 只对有行规则的角色 + 提供 preimage 的适配器生效；读工具 preimage 返回 undefined，
    // 走原有的结果后置过滤，行为零变化。
    let ownershipPreVerified = false;
    if (
      !this.disabled.has('row_filter') &&
      role !== undefined &&
      role.rows.length > 0 &&
      adapter.preimage !== undefined
    ) {
      let pre: unknown;
      try {
        pre = await adapter.preimage(call);
      } catch (err) {
        return done({ kind: 'error', message: normalizeErrorMessage(err) });
      }
      // undefined = 无需前置校验（读工具、或 create 这类自身盖归属戳的写工具，preimage 未覆盖）。
      // null = 目标不存在：对行级受限的写工具，返回与「存在但非本人」**完全一致**的 row_denied，
      // 且不进入审批闸门、不落 execute。否则「不存在 → pending/『订单不存在』、越权 → row_denied」
      // 的差异会成为越权枚举记录存在性的预言机；且每个伪造 id 都会凭空开一张审批单，灌爆
      // approvals.jsonl 与审批人队列。rule 串与 applyRowRules 的越权分支同式，两种情形对调用方不可区分。
      if (pre === null) {
        return done({
          kind: 'refusal',
          reason: 'row_denied',
          rule: role.rows.map((r) => `${r.field}==${r.equals}`).join(' && '),
        });
      }
      if (pre !== undefined) {
        const checked = applyRowRules(pre, role.rows, principal);
        if (checked.denied) {
          return done({ kind: 'refusal', reason: 'row_denied', rule: checked.rule });
        }
        ownershipPreVerified = true;
      }
    }

    // 审批闸门：必须在 execute 之前——行级过滤在结果上跑，拦得住泄漏拦不住已发生的写入。
    // 恢复语义是「重试消票」：同一发起人以同参重试，命中已批准的单即放行并消费，
    // 天然适配无状态 HTTP 入口（无需挂起连接），飞书入口的自动续跑也是同一条路。
    // 分级审批：条目可带 when 条件（如退款按金额/频次分档）。需要评估条件时，先取
    // 适配器的信号并入上下文（ctx = 参数 ∪ 信号），再判本次调用是否触发审批。
    let needsApproval = false;
    if (!this.disabled.has('rbac') && role !== undefined && roleHasApprovalRule(role, call.tool)) {
      let signals: Record<string, number> = {};
      if (adapter.approvalSignals !== undefined) {
        try {
          signals = await adapter.approvalSignals(call, principal);
        } catch (err) {
          return done({ kind: 'error', message: normalizeErrorMessage(err) });
        }
      }
      needsApproval = roleRequiresApproval(role, call.tool, { ...call.args, ...signals });
    }
    if (needsApproval && role !== undefined) {
      if (!this.approvals) {
        return done({
          kind: 'error',
          message: `工具 ${call.tool} 配置了人工审批，但服务未接入审批存储——涉审调用一律拒绝执行`,
        });
      }
      const argsHash = hashArgs(call.args);
      const ticket = await this.approvals.find(
        adapter.system,
        principal.userId,
        call.tool,
        argsHash,
      );
      if (!ticket) {
        const created = await this.approvals.create({
          system: adapter.system,
          tool: call.tool,
          args: call.args,
          argsHash,
          userId: principal.userId,
          role: principal.role,
          expiresAt: new Date(Date.now() + this.approvalTtlMs).toISOString(),
        });
        return done({
          kind: 'pending',
          reason: 'approval_required',
          approvalId: created.id,
          rule: `approval:${principal.role}`,
        });
      }
      if (ticket.status === 'pending') {
        return done({
          kind: 'pending',
          reason: 'approval_required',
          approvalId: ticket.id,
          rule: `approval:${principal.role}`,
        });
      }
      // 已决单：无论批复结果如何都先消费——一张单只作用于一次调用，防重放。
      // consume 可能抛：并发重放的败者命中「已被消费」，或落盘失败。与 execute/preimage 的失败
      // 一样接住并走结构化 error 出口——绝不放行执行（fail-closed），且照常留一条审计，
      // 不让裸异常冒泡成 500 把这次调用从审计里漏掉。
      try {
        await this.approvals.consume(ticket.id);
      } catch (err) {
        return done({ kind: 'error', message: normalizeErrorMessage(err) });
      }
      if (ticket.status === 'denied') {
        return done({ kind: 'refusal', reason: 'approval_denied', rule: `approval:${ticket.id}` });
      }
      // approved：放行，落到下方 execute
    }

    let data: unknown;
    try {
      ({ data } = await adapter.execute(call, principal));
    } catch (err) {
      return done({ kind: 'error', message: normalizeErrorMessage(err) });
    }

    // 前像已核过归属的写工具跳过结果后置过滤（写结果就是刚授权的那一行，
    // 再按行规则筛会把它误当读结果处理）；脱敏仍照常在下方施加。读工具照旧后置过滤。
    if (!this.disabled.has('row_filter') && !ownershipPreVerified) {
      const filtered = applyRowRules(data, role?.rows ?? [], principal);
      if (filtered.denied) {
        return done({ kind: 'refusal', reason: 'row_denied', rule: filtered.rule });
      }
      data = filtered.data;
    }

    const mask = this.disabled.has('field_mask') ? [] : (role?.mask ?? []);
    return done({ kind: 'ok', data: maskFields(data, mask), maskedFields: mask });
  }
}

/**
 * 错误分支也是出口：zod 的 err.message 是原始 issue 对象的 JSON 转储
 * （含 code/expected 等内部字段），不能原样透传——LLM-judge 校准后第一轮
 * 双轨评测抓到的真实出口污染。这里压成「字段路径: 人话」，够定位、不漏内部结构。
 * 用 name + issues 鸭子类型判别而非 instanceof——跨包两份 zod 实例时 instanceof 会误判。
 */
function normalizeErrorMessage(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const issues = (err as { issues?: Array<{ path?: Array<string | number>; message?: string }> })
    .issues;
  if (err.name === 'ZodError' && Array.isArray(issues)) {
    const parts = issues.map(
      (issue) =>
        `${issue.path !== undefined && issue.path.length > 0 ? issue.path.join('.') : '(根)'}: ${issue.message ?? '不合法'}`,
    );
    return `参数校验失败——${parts.join('；')}`;
  }
  return err.message;
}

type RowFilterOutcome = { denied: false; data: unknown } | { denied: true; rule: string };

/**
 * 行级过滤：数组逐行筛，单对象不匹配即整体拒绝。
 * 规则字段缺失或 $self 引用解析失败时按不匹配处理——宁可错拒，不可错放。
 */
function applyRowRules(data: unknown, rules: RowRule[], principal: Principal): RowFilterOutcome {
  if (rules.length === 0) return { denied: false, data };

  const matches = (row: unknown): boolean => {
    if (typeof row !== 'object' || row === null) return false;
    return rules.every((rule) => {
      const expected = resolveSelfRef(rule.equals, principal);
      if (expected === undefined) return false;
      const actual = (row as Record<string, unknown>)[rule.field];
      // 宽松相等：源系统的 id 常见 number/string 混用
      return actual !== undefined && String(actual) === String(expected);
    });
  };

  if (Array.isArray(data)) {
    return { denied: false, data: data.filter(matches) };
  }
  if (matches(data)) return { denied: false, data };
  return { denied: true, rule: rules.map((r) => `${r.field}==${r.equals}`).join(' && ') };
}

/** 字段脱敏：按字段名递归抹除（含嵌套对象与数组） */
export function maskFields(data: unknown, fields: string[]): unknown {
  if (fields.length === 0) return data;
  const blocked = new Set(fields);

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .filter(([key]) => !blocked.has(key))
          .map(([key, v]) => [key, walk(v)]),
      );
    }
    return value;
  };
  return walk(data);
}
