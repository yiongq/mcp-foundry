import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import type { Principal } from './types.js';

/**
 * 行级规则：结果集中每一行的 field 必须等于 equals 解出的值。
 * equals 支持 "$self.userId" / "$self.attrs.<key>" 引用提问人，或字面量。
 * 刻意不做表达式 DSL——可求值字符串是注入面，结构化对象不是。
 */
const rowRuleSchema = z.object({
  field: z.string().min(1),
  equals: z.union([z.string(), z.number()]),
});

const roleRuleSchema = z.object({
  tools: z.union([z.literal('*'), z.array(z.string().min(1))]),
  rows: z.array(rowRuleSchema).default([]),
  mask: z.array(z.string().min(1)).default([]),
});

const rbacConfigSchema = z.object({
  roles: z.record(z.string().min(1), roleRuleSchema),
});

export type RowRule = z.infer<typeof rowRuleSchema>;
export type RoleRule = z.infer<typeof roleRuleSchema>;
export type RbacConfig = z.infer<typeof rbacConfigSchema>;

export function loadRbacConfig(yamlText: string): RbacConfig {
  return rbacConfigSchema.parse(parseYaml(yamlText));
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
