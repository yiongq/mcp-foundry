import { describe, expect, it } from 'vitest';
import { extractPrincipal } from './principal.js';

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
