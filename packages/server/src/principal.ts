/**
 * principal 提取——MVP 的 demo 信任层：直接信任 x-foundry-user / x-foundry-role 请求头，
 * 服务端不验签。生产身份来自飞书事件/网关签名（W3 接入），届时只替换本模块，
 * Guard 管线与工具注册不动。
 */
import type { IncomingHttpHeaders } from 'node:http';
import type { Principal } from '@yiong/foundry-core';

export const USER_HEADER = 'x-foundry-user';
export const ROLE_HEADER = 'x-foundry-role';

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
