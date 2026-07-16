import { describe, expect, it } from 'vitest';
import { loadCases } from './schema.js';

describe('用例 schema', () => {
  it('解析合法 YAML：args 缺省 {}，category 缺省 uncategorized', () => {
    const cases = loadCases(`
cases:
  - id: c1
    title: 员工查自己
    category: normal
    tool: get_employee
    args: { employee_id: e002 }
    principal: { userId: e002, role: employee }
    expect: allow
    mustNotContainFields: [salary, phone]
    expectRowCount: 1
  - id: c2
    title: 未知角色
    tool: list_employees
    principal: { userId: x, role: ghost }
    expect: refuse
    expectRefusalReason: unknown_role
`);
    expect(cases).toHaveLength(2);
    expect(cases[0]?.args).toEqual({ employee_id: 'e002' });
    expect(cases[0]?.mustNotContainFields).toEqual(['salary', 'phone']);
    expect(cases[1]?.args).toEqual({});
    expect(cases[1]?.category).toBe('uncategorized');
    expect(cases[1]?.expectRefusalReason).toBe('unknown_role');
  });

  it('principal.attrs 允许 string/number 值', () => {
    const cases = loadCases(`
cases:
  - id: c1
    title: 带属性
    tool: list_employees
    principal: { userId: e001, role: dept_lead, attrs: { dept: 生产部, level: 3 } }
    expect: allow
`);
    expect(cases[0]?.principal.attrs).toEqual({ dept: '生产部', level: 3 });
  });

  it('expect 取值非法 → 抛错', () => {
    expect(() =>
      loadCases(`
cases:
  - id: c1
    title: t
    tool: t1
    principal: { userId: u, role: r }
    expect: maybe
`),
    ).toThrow();
  });

  it('用例 id 重复 → 抛错', () => {
    expect(() =>
      loadCases(`
cases:
  - id: dup
    title: a
    tool: t1
    principal: { userId: u, role: r }
    expect: allow
  - id: dup
    title: b
    tool: t1
    principal: { userId: u, role: r }
    expect: allow
`),
    ).toThrow(/重复/);
  });

  it('expectRefusalReason 出现在 expect=allow 的题里 → 抛错', () => {
    expect(() =>
      loadCases(`
cases:
  - id: c1
    title: t
    tool: t1
    principal: { userId: u, role: r }
    expect: allow
    expectRefusalReason: row_denied
`),
    ).toThrow(/expectRefusalReason/);
  });

  it('system 缺省 orangehrm；seed 步骤解析并给 args 缺省 {}', () => {
    const cases = loadCases(`
cases:
  - id: m1
    title: 跨会话召回
    system: memory
    seed:
      - tool: save_memory
        args: { content: 出差靠窗, session_id: s1 }
        principal: { userId: e002, role: employee }
      - tool: save_memory
        principal: { userId: e001, role: employee }
    tool: recall_memories
    principal: { userId: e002, role: employee }
    expect: allow
  - id: c1
    title: 默认系统
    tool: get_employee
    principal: { userId: e002, role: employee }
    expect: allow
`);
    expect(cases[0]?.system).toBe('memory');
    expect(cases[0]?.seed).toHaveLength(2);
    expect(cases[0]?.seed?.[1]?.args).toEqual({});
    expect(cases[1]?.system).toBe('orangehrm');
  });

  it('mustNotContainText 任何 expect 都可用；mustContainText 仅限 allow', () => {
    expect(() =>
      loadCases(`
cases:
  - id: c1
    title: 拒答分支也不得漏文本
    tool: t1
    principal: { userId: u, role: r }
    expect: refuse
    mustNotContainText: ["9800"]
`),
    ).not.toThrow();

    expect(() =>
      loadCases(`
cases:
  - id: c1
    title: t
    tool: t1
    principal: { userId: u, role: r }
    expect: refuse
    mustContainText: [靠窗]
`),
    ).toThrow(/mustContainText/);
  });

  it('expectRowCount 出现在 expect=refuse 的题里 → 抛错', () => {
    expect(() =>
      loadCases(`
cases:
  - id: c1
    title: t
    tool: t1
    principal: { userId: u, role: r }
    expect: refuse
    expectRowCount: 1
`),
    ).toThrow(/expectRowCount/);
  });
});
