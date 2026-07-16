import { describe, expect, it } from 'vitest';
import { extractPrincipal, resolvePrincipal } from './principal.js';
import { mintIdentityToken } from './token.js';

describe('extractPrincipal', () => {
  it('从 x-foundry-user / x-foundry-role 头解析 principal', () => {
    expect(extractPrincipal({ 'x-foundry-user': 'e002', 'x-foundry-role': 'employee' })).toEqual({
      userId: 'e002',
      role: 'employee',
    });
  });

  it('重复头取第一个值', () => {
    expect(
      extractPrincipal({ 'x-foundry-user': ['e002', 'e004'], 'x-foundry-role': 'employee' }),
    ).toEqual({ userId: 'e002', role: 'employee' });
  });

  it('缺任一头返回 null', () => {
    expect(extractPrincipal({})).toBeNull();
    expect(extractPrincipal({ 'x-foundry-user': 'e002' })).toBeNull();
    expect(extractPrincipal({ 'x-foundry-role': 'employee' })).toBeNull();
  });

  it('空值视同缺失', () => {
    expect(extractPrincipal({ 'x-foundry-user': '', 'x-foundry-role': 'employee' })).toBeNull();
    expect(extractPrincipal({ 'x-foundry-user': 'e002', 'x-foundry-role': '' })).toBeNull();
  });
});

describe('resolvePrincipal', () => {
  const SECRET = 'test-secret-at-least-16-chars';
  const NOW = 1_800_000_000;
  const tokenAuth = { mode: 'token' as const, secret: SECRET };

  it('headers 模式：行为与 extractPrincipal 一致', () => {
    expect(
      resolvePrincipal(
        { 'x-foundry-user': 'e002', 'x-foundry-role': 'employee' },
        {
          mode: 'headers',
        },
      ),
    ).toEqual({ ok: true, principal: { userId: 'e002', role: 'employee' } });
    expect(resolvePrincipal({}, { mode: 'headers' }).ok).toBe(false);
  });

  it('token 模式：有效 Bearer 令牌解析出 principal，scheme 大小写不敏感', () => {
    const token = mintIdentityToken(SECRET, { userId: 'e004', role: 'hr_admin' }, 3600, NOW);
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      expect(resolvePrincipal({ authorization: `${scheme} ${token}` }, tokenAuth, NOW)).toEqual({
        ok: true,
        principal: { userId: 'e004', role: 'hr_admin' },
      });
    }
  });

  it('token 模式：x-foundry-* 头被完全忽略——伪造头不在信任路径上', () => {
    const forged = {
      'x-foundry-user': 'e004',
      'x-foundry-role': 'hr_admin',
    };
    expect(resolvePrincipal(forged, tokenAuth, NOW).ok).toBe(false);

    const token = mintIdentityToken(SECRET, { userId: 'e002', role: 'employee' }, 3600, NOW);
    const verdict = resolvePrincipal(
      { ...forged, authorization: `Bearer ${token}` },
      tokenAuth,
      NOW,
    );
    expect(verdict).toEqual({ ok: true, principal: { userId: 'e002', role: 'employee' } });
  });

  it('token 模式：缺 Authorization / 非 Bearer scheme → 明确引导消息', () => {
    for (const headers of [{}, { authorization: 'Basic dXNlcjpwYXNz' }]) {
      expect(resolvePrincipal(headers, tokenAuth, NOW)).toEqual({
        ok: false,
        message: 'missing Authorization: Bearer <token> header',
      });
    }
  });

  it('token 模式：失败消息只分"过期"和"无效"，不区分坏签名/坏格式', () => {
    const expired = mintIdentityToken(SECRET, { userId: 'e002', role: 'employee' }, 60, NOW);
    expect(resolvePrincipal({ authorization: `Bearer ${expired}` }, tokenAuth, NOW + 120)).toEqual({
      ok: false,
      message: 'identity token expired',
    });
    for (const bad of ['garbage', 'a.b.c']) {
      expect(resolvePrincipal({ authorization: `Bearer ${bad}` }, tokenAuth, NOW)).toEqual({
        ok: false,
        message: 'invalid identity token',
      });
    }
  });
});
