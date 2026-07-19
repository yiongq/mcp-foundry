/**
 * principal 解析——三种鉴权模式，由部署方显式选择：
 *
 * - token（生产·单网关，W3）：只认 Authorization: Bearer <HS256 令牌>（见 token.ts），
 *   x-foundry-* 头在此模式下被完全忽略——伪造头不是"被拒绝"，是"根本不在信任路径上"。
 * - token-jwks（生产·多签发方，W5）：只认 Bearer <ES256/RS256 令牌>，按受信公钥集
 *   （JWKS，支持热重载与多 kid 轮换）验签；HS256 令牌在此模式下没有验签路径。
 * - headers（demo）：直接信任 x-foundry-user / x-foundry-role 请求头，不验签，
 *   仅用于本地演示与评测脚本。
 *
 * 无论哪种模式，出口都是同一个 Principal，Guard 管线与工具注册不感知鉴权方式。
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { Principal } from '@yiong/foundry-core';
import type { IdentityJwks } from './jwks.js';
import type { ClaimBinding } from './token.js';
import { verifyIdentityToken, verifyIdentityTokenJwks } from './token.js';

export const USER_HEADER = 'x-foundry-user';
export const ROLE_HEADER = 'x-foundry-role';
/** 可选：按系统覆盖角色（多帽子），格式 `orangehrm=hr_admin,twenty=sales_manager`。缺省回落到 x-foundry-role。 */
export const ROLES_HEADER = 'x-foundry-roles';

export type AuthConfig =
  | { mode: 'headers' }
  | { mode: 'token'; secret: string; expectedAud?: string; expectedIss?: string }
  | {
      mode: 'token-jwks';
      jwks: IdentityJwks | (() => IdentityJwks);
      expectedAud?: string;
      expectedIss?: string;
    };

export type PrincipalVerdict = { ok: true; principal: Principal } | { ok: false; message: string };

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && value !== '' ? value : null;
}

/** `orangehrm=hr_admin,twenty=sales_manager` → { orangehrm: 'hr_admin', twenty: 'sales_manager' }。空/坏格式返回 undefined。 */
function parseRolesHeader(value: string | null): Record<string, string> | undefined {
  if (value === null) return undefined;
  const out: Record<string, string> = {};
  for (const pair of value.split(',')) {
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const system = pair.slice(0, eq).trim();
    const role = pair.slice(eq + 1).trim();
    if (system !== '' && role !== '') out[system] = role;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 两个头缺一不可、空值视同缺失——宁可 401，不给 Guard 喂半截身份。 */
export function extractPrincipal(headers: IncomingHttpHeaders): Principal | null {
  const userId = headerValue(headers, USER_HEADER);
  const role = headerValue(headers, ROLE_HEADER);
  if (userId === null || role === null) return null;
  const rolesBySystem = parseRolesHeader(headerValue(headers, ROLES_HEADER));
  return rolesBySystem !== undefined ? { userId, role, rolesBySystem } : { userId, role };
}

function extractBearerToken(headers: IncomingHttpHeaders): string | null {
  const raw = headerValue(headers, 'authorization');
  if (raw === null) return null;
  const match = /^Bearer\s+(\S+)$/i.exec(raw);
  return match?.[1] ?? null;
}

/** 失败消息只描述"客户端该怎么做"，不区分坏签名/坏格式——不给探测者反馈面。 */
export function resolvePrincipal(
  headers: IncomingHttpHeaders,
  auth: AuthConfig,
  now?: number,
): PrincipalVerdict {
  if (auth.mode === 'headers') {
    const principal = extractPrincipal(headers);
    return principal !== null
      ? { ok: true, principal }
      : { ok: false, message: `missing ${USER_HEADER} / ${ROLE_HEADER} headers` };
  }

  const token = extractBearerToken(headers);
  if (token === null) {
    return { ok: false, message: 'missing Authorization: Bearer <token> header' };
  }

  // 可选受众/签发方绑定：网关声明期望时才校验（多签发方共用一套 JWKS 时的防串用）。
  // 未声明 = 空对象 = 不校验，与旧行为一致。now 为 undefined 时交给验签函数的默认取当前秒。
  const expect: ClaimBinding = {
    ...(auth.expectedAud !== undefined ? { aud: auth.expectedAud } : {}),
    ...(auth.expectedIss !== undefined ? { iss: auth.expectedIss } : {}),
  };
  let verdict: ReturnType<typeof verifyIdentityToken>;
  if (auth.mode === 'token') {
    verdict = verifyIdentityToken(auth.secret, token, now, expect);
  } else {
    // 加载器抛错（如文件被移走且无缓存）按验签失败处理——宁可 401，不放行
    let jwks: IdentityJwks;
    try {
      jwks = typeof auth.jwks === 'function' ? auth.jwks() : auth.jwks;
    } catch {
      return { ok: false, message: 'invalid identity token' };
    }
    verdict = verifyIdentityTokenJwks(jwks, token, now, expect);
  }
  if (!verdict.ok) {
    return {
      ok: false,
      message: verdict.reason === 'expired' ? 'identity token expired' : 'invalid identity token',
    };
  }
  return { ok: true, principal: verdict.principal };
}
