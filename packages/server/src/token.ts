/**
 * 身份令牌：HS256（W3，单网关共享密钥）与 ES256/RS256 × JWKS（W5，多签发方/密钥轮换）
 * 两条验签路径，node:crypto 零新依赖。
 *
 * 信任模型：签发方（网关/SSO/管理员 CLI）签发 {sub, role, iat, exp}，
 * Foundry 验签 + 验过期。签发方是身份权威——角色声明随签名一起被背书，
 * 客户端改一个字节整条令牌作废。
 *
 * 算法选择纪律（两条路径同一条）：验签用什么算法由**服务端配置**决定——
 * HS256 路径按服务端密钥算 HMAC；JWKS 路径由**受信密钥集中被 kid 命中的那把键
 * 自己的 kty** 决定（EC→ES256 / RSA→RS256）。令牌头部自述的 alg 从头到尾没人读，
 * "alg: none"、HS256/RS256 混淆一类的算法降级攻击在结构上不成立，而非被规则挡住。
 * kid 只是受信集合内的查找提示：查不到、格式不对都进 bad_signature 一个桶，
 * 不给探测者区分反馈。
 */
import {
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  timingSafeEqual,
} from 'node:crypto';
import type { Principal } from '@yiong/foundry-core';
import type { IdentityJwks } from './jwks.js';

export interface IdentityClaims {
  sub: string;
  role: string;
  /** 可选：按系统覆盖角色（多帽子）。签发方背书，与签名一同被验。缺省回落到 role。 */
  roles?: Record<string, string>;
  iat: number;
  /** 生效时间（not-before）。签发即置 = iat；验签带小幅时钟偏移容忍。 */
  nbf?: number;
  exp: number;
  /** 可选受众/签发方绑定：多签发方共用一套 JWKS 时，验签方声明期望即可挡住「发给别的服务的令牌」。 */
  aud?: string;
  iss?: string;
}

/** 受众/签发方绑定：签发时写入令牌，验签时按期望值校验（仅在声明期望时生效）。 */
export interface ClaimBinding {
  aud?: string;
  iss?: string;
}

export type TokenVerdict =
  | { ok: true; principal: Principal }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'bad_claims' | 'expired' };

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

const b64url = (data: string | Buffer): string => Buffer.from(data).toString('base64url');

const hmac = (secret: string, signingInput: string): Buffer =>
  createHmac('sha256', secret).update(signingInput).digest();

function assertSecret(secret: string): void {
  if (secret.length < 16) {
    throw new Error('identity secret must be at least 16 characters');
  }
}

function buildClaims(
  principal: Principal,
  ttlSeconds: number,
  issuedAt: number,
  binding?: ClaimBinding,
): IdentityClaims {
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('ttlSeconds must be a positive number');
  }
  return {
    sub: principal.userId,
    role: principal.role,
    ...(principal.rolesBySystem !== undefined ? { roles: principal.rolesBySystem } : {}),
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + ttlSeconds,
    ...(binding?.aud !== undefined ? { aud: binding.aud } : {}),
    ...(binding?.iss !== undefined ? { iss: binding.iss } : {}),
  };
}

/** roles claim 合法性：对象且每个值都是非空字符串，否则忽略（回落到 role）。 */
function validRolesClaim(roles: unknown): roles is Record<string, string> {
  return (
    typeof roles === 'object' &&
    roles !== null &&
    !Array.isArray(roles) &&
    Object.values(roles).every((v) => typeof v === 'string' && v !== '')
  );
}

/** 签名通过之后才解析 payload；三段式/空段在调用方已挡掉。 */
function parseVerifiedClaims(payload: string, now: number, expect?: ClaimBinding): TokenVerdict {
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
  // 未生效（nbf）：允许签发方发未来生效令牌；带 30s 时钟偏移容忍，超前太多即拒。
  const NBF_LEEWAY_SECONDS = 30;
  if (Number.isFinite(claims.nbf) && (claims.nbf as number) > now + NBF_LEEWAY_SECONDS) {
    return { ok: false, reason: 'bad_claims' };
  }
  if ((claims.exp as number) <= now) return { ok: false, reason: 'expired' };

  // 受众/签发方绑定：仅当验签方声明期望值才校验（未声明 = 不校验，向后兼容）。多签发方
  // 共用一套 JWKS 时，这道挡住「本该发给别的服务的令牌，凭 role 声明在此被接受」。
  if (expect?.aud !== undefined && claims.aud !== expect.aud) {
    return { ok: false, reason: 'bad_claims' };
  }
  if (expect?.iss !== undefined && claims.iss !== expect.iss) {
    return { ok: false, reason: 'bad_claims' };
  }

  return {
    ok: true,
    principal: {
      userId: claims.sub,
      role: claims.role,
      ...(validRolesClaim(claims.roles) ? { rolesBySystem: claims.roles } : {}),
    },
  };
}

function splitToken(token: string): [string, string, string] | null {
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => p === '')) return null;
  return parts as [string, string, string];
}

export function mintIdentityToken(
  secret: string,
  principal: Principal,
  ttlSeconds: number,
  issuedAt = nowSeconds(),
  binding?: ClaimBinding,
): string {
  assertSecret(secret);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const claims = buildClaims(principal, ttlSeconds, issuedAt, binding);
  const signingInput = `${header}.${b64url(JSON.stringify(claims))}`;
  return `${signingInput}.${b64url(hmac(secret, signingInput))}`;
}

/** 先验签后解析：签名不过的字节一律不进 JSON.parse，payload 不成为解析攻击面。 */
export function verifyIdentityToken(
  secret: string,
  token: string,
  now = nowSeconds(),
  expect?: ClaimBinding,
): TokenVerdict {
  assertSecret(secret);
  const parts = splitToken(token);
  if (parts === null) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts;

  const expected = hmac(secret, `${header}.${payload}`);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }

  return parseVerifiedClaims(payload, now, expect);
}

/**
 * ES256 签发（P-256 EC 私钥，PEM）。演示里由 keygen + mint-token CLI 扮演
 * "独立签发方"；生产由网关/SSO 持私钥签发，Foundry 只见公钥 JWKS。
 * JWT 的 ES256 签名是裸 R||S（ieee-p1363），不是 ASN.1/DER——两边都要钉住。
 */
export function mintIdentityTokenEs256(
  privateKeyPem: string,
  kid: string,
  principal: Principal,
  ttlSeconds: number,
  issuedAt = nowSeconds(),
  binding?: ClaimBinding,
): string {
  if (kid === '') throw new Error('kid must be non-empty');
  const key = createPrivateKey(privateKeyPem);
  if (key.asymmetricKeyType !== 'ec') {
    throw new Error('ES256 signing requires an EC (P-256) private key');
  }
  const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT', kid }));
  const claims = buildClaims(principal, ttlSeconds, issuedAt, binding);
  const signingInput = `${header}.${b64url(JSON.stringify(claims))}`;
  const signature = cryptoSign('sha256', Buffer.from(signingInput), {
    key,
    dsaEncoding: 'ieee-p1363',
  });
  return `${signingInput}.${b64url(signature)}`;
}

/**
 * JWKS 验签：头部只取 kid 当受信密钥集的查找键（这是验签前唯一解析的字段，
 * 也决定不了任何密码学参数）；命中键的 kty 决定验签算法。payload 仍是
 * 先验签后解析。kid 缺失/未命中/公钥导入失败统一 bad_signature——
 * 对外与坏签名不可区分。
 */
export function verifyIdentityTokenJwks(
  jwks: IdentityJwks,
  token: string,
  now = nowSeconds(),
  expect?: ClaimBinding,
): TokenVerdict {
  const parts = splitToken(token);
  if (parts === null) return { ok: false, reason: 'malformed' };
  const [header, payload, signature] = parts;

  let kid: unknown;
  try {
    kid = (JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as { kid?: unknown }).kid;
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof kid !== 'string' || kid === '') return { ok: false, reason: 'bad_signature' };

  const jwk = jwks.keys.find((k) => k.kid === kid);
  if (jwk === undefined) return { ok: false, reason: 'bad_signature' };

  let valid: boolean;
  try {
    const key = createPublicKey({ key: jwk, format: 'jwk' });
    const signingInput = Buffer.from(`${header}.${payload}`);
    const sig = Buffer.from(signature, 'base64url');
    valid =
      jwk.kty === 'EC'
        ? cryptoVerify('sha256', signingInput, { key, dsaEncoding: 'ieee-p1363' }, sig)
        : cryptoVerify('sha256', signingInput, key, sig);
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
  if (!valid) return { ok: false, reason: 'bad_signature' };

  return parseVerifiedClaims(payload, now, expect);
}
