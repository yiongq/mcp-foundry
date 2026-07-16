import { type AuditLogger, hashArgs } from './audit.js';
import { type RbacConfig, type RowRule, resolveSelfRef } from './rbac.js';
import type { GuardedResult, Principal, SystemAdapter, ToolCall, ToolSpec } from './types.js';

/** 守卫的三道防线，评测 ablation 按此粒度逐层关闭以量化每层贡献。 */
export type GuardLayer = 'rbac' | 'row_filter' | 'field_mask';

export interface GuardOptions {
  /**
   * 仅供评测 ablation（守卫开/关对照实验）使用——生产路径永远全开。
   * 'rbac' 同时涵盖角色查找与工具白名单两个检查。
   */
  disabledLayers?: readonly GuardLayer[];
}

/**
 * 守卫管线，权限的唯一收口：
 *   角色查找 → 工具白名单 → 适配器执行 → 行级过滤 → 字段脱敏 → 审计
 * 任何一步失败都走结构化拒答/错误分支，且两类分支都不携带业务数据。
 */
export class Guard {
  private readonly disabled: ReadonlySet<GuardLayer>;

  constructor(
    private readonly rbac: RbacConfig,
    private readonly audit: AuditLogger,
    options: GuardOptions = {},
  ) {
    this.disabled = new Set(options.disabledLayers ?? []);
  }

  /** tools/list 阶段就按角色收窄——不该用的工具连列表里都不出现 */
  allowedTools(adapter: SystemAdapter, principal: Principal): ToolSpec[] {
    if (this.disabled.has('rbac')) return adapter.tools();
    const role = this.rbac.roles[principal.role];
    if (!role) return [];
    if (role.tools === '*') return adapter.tools();
    const allowed = new Set(role.tools);
    return adapter.tools().filter((t) => allowed.has(t.name));
  }

  async invoke(
    adapter: SystemAdapter,
    principal: Principal,
    call: ToolCall,
  ): Promise<GuardedResult> {
    const startedAt = performance.now();
    const done = async (result: GuardedResult): Promise<GuardedResult> => {
      await this.audit.log({
        ts: new Date().toISOString(),
        userId: principal.userId,
        role: principal.role,
        system: adapter.system,
        tool: call.tool,
        decision: result.kind === 'ok' ? 'ALLOW' : result.kind === 'refusal' ? 'DENY' : 'ERROR',
        ...(result.kind === 'refusal' ? { reason: result.reason, rule: result.rule } : {}),
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

    let data: unknown;
    try {
      ({ data } = await adapter.execute(call, principal));
    } catch (err) {
      return done({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }

    if (!this.disabled.has('row_filter')) {
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
