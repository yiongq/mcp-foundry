import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mintIdentityToken, verifyIdentityToken } from './token.js';

const SECRET = 'test-secret-at-least-16-chars';
const NOW = 1_800_000_000;

const b64url = (obj: unknown): string => Buffer.from(JSON.stringify(obj)).toString('base64url');

describe('mintIdentityToken / verifyIdentityToken', () => {
  it('签发→验签 roundtrip，principal 原样恢复', () => {
    const token = mintIdentityToken(SECRET, { userId: 'e004', role: 'hr_admin' }, 3600, NOW);
    expect(verifyIdentityToken(SECRET, token, NOW + 10)).toEqual({
      ok: true,
      principal: { userId: 'e004', role: 'hr_admin' },
    });
  });

  it('过期令牌拒绝，exp 恰好等于 now 也算过期', () => {
    const token = mintIdentityToken(SECRET, { userId: 'e002', role: 'employee' }, 60, NOW);
    expect(verifyIdentityToken(SECRET, token, NOW + 61)).toEqual({
      ok: false,
      reason: 'expired',
    });
    expect(verifyIdentityToken(SECRET, token, NOW + 60)).toEqual({ ok: false, reason: 'expired' });
    expect(verifyIdentityToken(SECRET, token, NOW + 59).ok).toBe(true);
  });

  it('篡改 payload 提权（employee→hr_admin）：签名作废', () => {
    const token = mintIdentityToken(SECRET, { userId: 'e002', role: 'employee' }, 3600, NOW);
    const [header, payload, sig] = token.split('.') as [string, string, string];
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      role: string;
    };
    claims.role = 'hr_admin';
    const forged = `${header}.${b64url(claims)}.${sig}`;
    expect(verifyIdentityToken(SECRET, forged, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('alg 降级（alg: none、空签名）不成立——验签不读令牌自述的 alg', () => {
    const payload = b64url({ sub: 'e002', role: 'hr_admin', iat: NOW, exp: NOW + 3600 });
    const noneToken = `${b64url({ alg: 'none', typ: 'JWT' })}.${payload}.x`;
    expect(verifyIdentityToken(SECRET, noneToken, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    const emptySig = `${b64url({ alg: 'none', typ: 'JWT' })}.${payload}.`;
    expect(verifyIdentityToken(SECRET, emptySig, NOW)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('错密钥验签失败', () => {
    const token = mintIdentityToken(SECRET, { userId: 'e004', role: 'hr_admin' }, 3600, NOW);
    expect(verifyIdentityToken('another-secret-16-chars!', token, NOW)).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
  });

  it('结构不对的令牌一律 malformed', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', '..']) {
      expect(verifyIdentityToken(SECRET, bad, NOW)).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('签名有效但 claims 残缺（缺 role / sub 为空 / 无 exp）→ bad_claims', () => {
    const forge = (claims: unknown): string => {
      const signingInput = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
      const sig = createHmac('sha256', SECRET).update(signingInput).digest('base64url');
      return `${signingInput}.${sig}`;
    };
    for (const claims of [
      { sub: 'e002', iat: NOW, exp: NOW + 60 },
      { sub: '', role: 'employee', iat: NOW, exp: NOW + 60 },
      { sub: 'e002', role: 'employee', iat: NOW },
    ]) {
      expect(verifyIdentityToken(SECRET, forge(claims), NOW)).toEqual({
        ok: false,
        reason: 'bad_claims',
      });
    }
  });

  it('弱密钥（<16 字符）签发与验签都拒绝', () => {
    expect(() => mintIdentityToken('short', { userId: 'e002', role: 'employee' }, 60)).toThrow();
    expect(() => verifyIdentityToken('short', 'a.b.c')).toThrow();
  });
});
