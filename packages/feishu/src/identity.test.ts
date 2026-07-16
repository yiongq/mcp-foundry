import { describe, expect, it } from 'vitest';
import { loadIdentityMap, resolvePrincipal } from './identity.js';

describe('身份映射', () => {
  it('解析绑定表并按 open_id 解出 principal', () => {
    const map = loadIdentityMap(`
identities:
  ou_abc: { userId: e002, role: employee }
  ou_def: { userId: e004, role: hr_admin }
`);
    expect(resolvePrincipal(map, 'ou_abc')).toEqual({ userId: 'e002', role: 'employee' });
    expect(resolvePrincipal(map, 'ou_def')).toEqual({ userId: 'e004', role: 'hr_admin' });
  });

  it('未绑定的 open_id 返回 null——没有任何默认身份兜底', () => {
    const map = loadIdentityMap('identities: {}');
    expect(resolvePrincipal(map, 'ou_ghost')).toBeNull();
  });

  it('空文件/缺 identities 键按空表处理', () => {
    expect(loadIdentityMap('')).toEqual({});
    expect(loadIdentityMap('# 只有注释')).toEqual({});
  });

  it('缺 userId/role 的绑定直接抛错，不静默放行', () => {
    expect(() => loadIdentityMap('identities: { ou_x: { userId: e001 } }')).toThrow();
  });
});
