import type { Guard, GuardedResult, Principal, SystemAdapter } from '@yiong/foundry-core';
import { zodToJsonSchema } from 'zod-to-json-schema';

/**
 * 多系统守卫工具集：每个系统一对（adapter, guard）——RBAC 按系统分治
 * （业务域 hr_admin 全权、记忆域人人只见自己），与评测 runner 的 systems 同构。
 * 给 LLM 的工具列表按身份收窄：白名单外的工具连定义都不出现，
 * 与 MCP server 的 tools/list 行为一致——收窄发生在模型看到工具之前。
 */
export interface GuardedSystem {
  adapter: SystemAdapter;
  guard: Guard;
}

export interface LlmToolSpec {
  name: string;
  description: string;
  /** JSON Schema（OpenAI tools.function.parameters 形状） */
  parameters: Record<string, unknown>;
}

export class GuardedToolset {
  constructor(private readonly systems: readonly GuardedSystem[]) {
    // 工具名是扁平命名空间，跨系统撞名会让路由失真——启动期直接拒绝
    const owner = new Map<string, string>();
    for (const { adapter } of systems) {
      for (const spec of adapter.tools()) {
        const existing = owner.get(spec.name);
        if (existing !== undefined) {
          throw new Error(`工具名冲突 "${spec.name}"（${existing} 与 ${adapter.system}）`);
        }
        owner.set(spec.name, adapter.system);
      }
    }
  }

  allowedTools(principal: Principal): LlmToolSpec[] {
    return this.systems.flatMap(({ adapter, guard }) =>
      guard.allowedTools(adapter, principal).map((spec) => {
        const parameters = zodToJsonSchema(spec.inputSchema, {
          $refStrategy: 'none',
        }) as Record<string, unknown>;
        delete parameters.$schema;
        return { name: spec.name, description: spec.description, parameters };
      }),
    );
  }

  /** 按工具名路由到所属系统的守卫执行；不存在的工具走 error 分支（不抛，保住对话） */
  async invoke(
    principal: Principal,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<GuardedResult> {
    for (const { adapter, guard } of this.systems) {
      if (adapter.tools().some((t) => t.name === tool)) {
        return guard.invoke(adapter, principal, { tool, args });
      }
    }
    return { kind: 'error', message: `未知工具 "${tool}"` };
  }
}
