import type { Principal } from '@yiong/foundry-core';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * 身份透传的入口侧：飞书事件里的 sender open_id（由飞书服务端签发，客户端伪造不了）
 * 映射到 Foundry principal。映射表是管理员手工维护的配置——绑定是管理动作，
 * 不提供任何"自助声明角色"的通道。未绑定的用户由 bot 回复其 open_id 引导管理员绑定。
 */
const identityFileSchema = z.object({
  identities: z
    .record(
      z.string().min(1),
      z.object({
        userId: z.string().min(1),
        role: z.string().min(1),
      }),
    )
    .default({}),
});

export type IdentityMap = z.infer<typeof identityFileSchema>['identities'];

export function loadIdentityMap(yamlText: string): IdentityMap {
  return identityFileSchema.parse(parseYaml(yamlText) ?? {}).identities;
}

export function resolvePrincipal(map: IdentityMap, senderId: string): Principal | null {
  const entry = map[senderId];
  if (entry === undefined) return null;
  return { userId: entry.userId, role: entry.role };
}
