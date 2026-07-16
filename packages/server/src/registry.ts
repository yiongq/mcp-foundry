import type { Guard, Principal, SystemAdapter, ToolSpec } from '@yiong/foundry-core';
import type { z } from 'zod';

export interface ToolEntry {
  adapter: SystemAdapter;
  spec: ToolSpec;
}

/** tools/list 阶段就按角色收窄——不在白名单里的工具连列表都不出现。 */
export function allowedToolEntries(
  adapters: readonly SystemAdapter[],
  guard: Guard,
  principal: Principal,
): ToolEntry[] {
  return adapters.flatMap((adapter) =>
    guard.allowedTools(adapter, principal).map((spec) => ({ adapter, spec })),
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
