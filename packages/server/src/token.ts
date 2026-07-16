/**
 * 身份令牌（W3 网关签名）：HS256 JWT 的最小自实现，node:crypto 零新依赖。
 *
 * 信任模型：网关（或管理员 CLI）持共享密钥签发 {sub, role, iat, exp}，
 * Foundry 验签 + 验过期。签发方是身份权威——角色声明随签名一起被背书，
 * 客户端改一个字节整条令牌作废。
 *
 * 验签永远按服务端自己的 HS256 + 密钥计算，不读令牌头部自述的 alg——
 * "alg: none" 一类的算法降级攻击在结构上不成立，而非被规则挡住。
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Principal } from '@yiong/foundry-core';

export interface IdentityClaims {
  sub: string;
  role: string;
  iat: number;
  exp: number;
}

export type TokenVerdict =
  | { ok: true; principal: Principal }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'bad_claims' | 'expired' };

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

const sign = (secret: string, signingInput: string): Buffer =>
  createHmac('sha256', secret).update(signingInput).digest();

function assertSecret(secret: string): void {
  if (secret.length < 16) {
    throw new Error('identity secret must be at least 16 characters');
  }
}

export function mintIdentityToken(
  secret: string,
  principal: Principal,
  ttlSeconds: number,
  issuedAt = nowSeconds(),
): string {
  assertSecret(secret);
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive number');
  }
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims: IdentityClaims = {
    sub: principal.userId,
    role: principal.role,
    iat: issuedAt,
    exp: issuedAt + ttlSeconds,
  };
  const signingInput = `${header}.${b64url(JSON.stringify(claims))}`;
  return `${signingInput}.${b64url(sign(secret, signingInput))}`;
}

/** 先验签后解析：签名不过的字节一律不进 JSON.parse，payload 不成为解析攻击面。 */
export function verifyIdentityToken(
  secret: string,
  token: string,
  now = nowSeconds(),
): TokenVerdict {
  assertSecret(secret);
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p === '')) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts as [string, string, string];

  const expected = sign(secret, `${header}.${payload}`);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let claims: Partial<IdentityClaims>;
  try {
    claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    ) as Partial<IdentityClaims>;
  } catch {
    return { ok: false, reason: 'bad_claims' };
  }
  if (
    typeof claims.sub !== 'string' ||
    claims.sub === '' ||
    typeof claims.role !== 'string' ||
    claims.role === '' ||
    !Number.isFinite(claims.exp)
  ) {
    return { ok: false, reason: 'bad_claims' };
  }
  if ((claims.exp as number) <= now) return { ok: false, reason: 'expired' };

  return { ok: true, principal: { userId: claims.sub, role: claims.role } };
}
