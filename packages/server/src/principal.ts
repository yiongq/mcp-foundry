/**
 * principal 解析——两种鉴权模式，由部署方显式选择：
 *
 * - token（生产，W3）：只认 Authorization: Bearer <HS256 令牌>（见 token.ts），
 *   x-foundry-* 头在此模式下被完全忽略——伪造头不是"被拒绝"，是"根本不在信任路径上"。
 * - headers（demo）：直接信任 x-foundry-user / x-foundry-role 请求头，不验签，
 *   仅用于本地演示与评测脚本。
 *
 * 无论哪种模式，出口都是同一个 Principal，Guard 管线与工具注册不感知鉴权方式。
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { Principal } from '@yiong/foundry-core';
import { verifyIdentityToken } from './token.js';

export const USER_HEADER = 'x-foundry-user';
export const ROLE_HEADER = 'x-foundry-role';

export type AuthConfig = { mode: 'headers' } | { mode: 'token'; secret: string };

export type PrincipalVerdict = { ok: true; principal: Principal } | { ok: false; message: string };

function headerValue(headers: IncomingHttpHeaders, name: string): string | null {
  const raw = headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value !== undefined && value !== '' ? value : null;
}

/** 两个头缺一不可、空值视同缺失——宁可 401，不给 Guard 喂半截身份。 */
export function extractPrincipal(headers: IncomingHttpHeaders): Principal | null {
  const userId = headerValue(headers, USER_HEADER);
  const role = headerValue(headers, ROLE_HEADER);
  if (userId === null || role === null) return null;
  return { userId, role };
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
  const verdict =
    now === undefined
      ? verifyIdentityToken(auth.secret, token)
      : verifyIdentityToken(auth.secret, token, now);
  if (!verdict.ok) {
    return {
      ok: false,
      message: verdict.reason === 'expired' ? 'identity token expired' : 'invalid identity token',
    };
  }
  return { ok: true, principal: verdict.principal };
}
