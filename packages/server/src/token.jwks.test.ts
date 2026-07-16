import { createHmac, sign as cryptoSign, generateKeyPairSync } from 'node:crypto';
import type { Principal } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import type { IdentityJwks, IdentityPublicJwk } from './jwks.js';
import { mintIdentityTokenEs256, verifyIdentityTokenJwks } from './token.js';

const WHO: Principal = { userId: 'e004', role: 'hr_admin' };

function es256Issuer(kid: string): { pem: string; jwk: IdentityPublicJwk } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as object), kid } as IdentityPublicJwk;
  return { pem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string, jwk };
}

const b64url = (s: string | Buffer): string => Buffer.from(s).toString('base64url');

describe('ES256 × JWKS', () => {
  it('签发-验签往返：principal 原样回来', () => {
    const { pem, jwk } = es256Issuer('k1');
    const token = mintIdentityTokenEs256(pem, 'k1', WHO, 3600);
    const verdict = verifyIdentityTokenJwks({ keys: [jwk] }, token);
    expect(verdict).toEqual({ ok: true, principal: WHO });
  });

  it('密钥轮换：新旧 kid 并存都验过；旧键从集合删除后旧令牌立即失效', () => {
    const old = es256Issuer('2026-01');
    const fresh = es256Issuer('2026-07');
    const oldToken = mintIdentityTokenEs256(old.pem, '2026-01', WHO, 3600);
    const freshToken = mintIdentityTokenEs256(fresh.pem, '2026-07', WHO, 3600);

    const during: IdentityJwks = { keys: [old.jwk, fresh.jwk] };
    expect(verifyIdentityTokenJwks(during, oldToken).ok).toBe(true);
    expect(verifyIdentityTokenJwks(during, freshToken).ok).toBe(true);

    const after: IdentityJwks = { keys: [fresh.jwk] };
    expect(verifyIdentityTokenJwks(after, oldToken)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(verifyIdentityTokenJwks(after, freshToken).ok).toBe(true);
  });

  it('kid 未命中 / 缺失：与坏签名同一个桶，不给探测反馈', () => {
    const { pem, jwk } = es256Issuer('k1');
    const token = mintIdentityTokenEs256(pem, 'ghost', WHO, 3600);
    expect(verifyIdentityTokenJwks({ keys: [jwk] }, token)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });

    // 无 kid 的头（其余合法）
    const header = b64url(JSON.stringify({ alg: 'ES256', typ: 'JWT' }));
    const parts = token.split('.') as [string, string, string];
    const noKid = `${header}.${parts[1]}.${parts[2]}`;
    expect(verifyIdentityTokenJwks({ keys: [jwk] }, noKid)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('算法混淆：拿公钥坐标当 HMAC 密钥伪造 HS256 令牌——JWKS 模式没有 HMAC 路径，结构上不成立', () => {
    const { jwk } = es256Issuer('k1');
    const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', kid: 'k1' }));
    const claims = b64url(
      JSON.stringify({ sub: 'e002', role: 'hr_admin', iat: 0, exp: 4102444800 }),
    );
    const input = `${header}.${claims}`;
    const forged = `${input}.${b64url(
      createHmac('sha256', `${(jwk as { x?: string }).x}${(jwk as { y?: string }).y}`)
        .update(input)
        .digest(),
    )}`;
    expect(verifyIdentityTokenJwks({ keys: [jwk] }, forged)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('篡改 payload 提权 → 签名作废', () => {
    const { pem, jwk } = es256Issuer('k1');
    const token = mintIdentityTokenEs256(pem, 'k1', { userId: 'e002', role: 'employee' }, 3600);
    const [header, payload, sig] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      role: string;
    };
    claims.role = 'hr_admin';
    const forged = `${header}.${b64url(JSON.stringify(claims))}.${sig}`;
    expect(verifyIdentityTokenJwks({ keys: [jwk] }, forged)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('过期令牌 → expired；头部不是 JSON → malformed', () => {
    const { pem, jwk } = es256Issuer('k1');
    const now = Math.floor(Date.now() / 1000);
    const expired = mintIdentityTokenEs256(pem, 'k1', WHO, 10, now - 100);
    expect(verifyIdentityTokenJwks({ keys: [jwk] }, expired)).toEqual({
      ok: false,
      reason: 'expired',
    });

    const good = mintIdentityTokenEs256(pem, 'k1', WHO, 3600);
    const parts = good.split('.') as [string, string, string];
    const badHeader = `${b64url('not-json')}.${parts[1]}.${parts[2]}`;
    expect(verifyIdentityTokenJwks({ keys: [jwk] }, badHeader)).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });

  it('RS256：RSA 键同一套验签路径（算法由密钥 kty 决定）', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const jwk = {
      ...(publicKey.export({ format: 'jwk' }) as object),
      kid: 'r1',
    } as IdentityPublicJwk;
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: 'r1' }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(
      JSON.stringify({ sub: 'e005', role: 'sales_manager', iat: now, exp: now + 600 }),
    );
    const input = `${header}.${payload}`;
    const token = `${input}.${b64url(cryptoSign('sha256', Buffer.from(input), privateKey))}`;

    expect(verifyIdentityTokenJwks({ keys: [jwk] }, token)).toEqual({
      ok: true,
      principal: { userId: 'e005', role: 'sales_manager' },
    });
  });
});
