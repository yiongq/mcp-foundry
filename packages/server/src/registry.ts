import type { Guard, Principal, SystemAdapter, ToolSpec } from '@yiong/foundry-core';
import type { z } from 'zod';

/**
 * 一个受守卫的系统 = 适配器 × 该系统自己的守卫。RBAC 按系统分治
 * （与飞书入口的 GuardedToolset、评测 runner 的 systems 同构）——
 * 通配角色（tools: "*"）的权力边界止步于本域，跨域即 unknown_role。
 */
export interface GuardedSystem {
  adapter: SystemAdapter;
  guard: Guard;
}

export interface ToolEntry {
  adapter: SystemAdapter;
  guard: Guard;
  spec: ToolSpec;
}

/** tools/list 阶段就按角色收窄——不在白名单里的工具连列表都不出现。 */
export function allowedToolEntries(
  systems: readonly GuardedSystem[],
  principal: Principal,
): ToolEntry[] {
  return systems.flatMap(({ adapter, guard }) =>
    guard.allowedTools(adapter, principal).map((spec) => ({ adapter, guard, spec })),
  );
}

/** MCP 工具名是扁平命名空间；跨适配器同名会让按名分发失真，启动期直接拒绝。 */
export function assertUniqueToolNames(adapters: readonly SystemAdapter[]): void {
  const owner = new Map<string, string>();
  for (const adapter of adapters) {
    for (const spec of adapter.tools()) {
      const existing = owner.get(spec.name);
      if (existing !== undefined) {
        throw new Error(`duplicate tool name "${spec.name}" (${existing} vs ${adapter.system})`);
      }
      owner.set(spec.name, adapter.system);
    }
  }
}

/**
 * SDK v1.x 的 registerTool 只收 ZodRawShape（对象字段表），不收完整 schema；
 * 用 _def.typeName 判别而非 instanceof——跨包出现两份 zod 实例时 instanceof 会误判。
 */
export function toRawShape(schema: z.ZodType, toolName: string): z.ZodRawShape {
  const def = (schema as { _def?: { typeName?: string } })._def;
  if (def?.typeName !== 'ZodObject') {
    throw new Error(`tool "${toolName}": inputSchema must be z.object(...)`);
  }
  return (schema as z.AnyZodObject).shape;
}
