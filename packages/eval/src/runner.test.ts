import type { SystemAdapter } from '@yiong/foundry-core';
import { loadRbacConfig } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assertCase, findForbiddenFields, runEval } from './runner.js';
import type { EvalCase } from './schema.js';

const ROWS = [
  { employee_id: 'e001', name: '张三', dept: '生产部', salary: 18500, phone: '13800000001' },
  { employee_id: 'e002', name: '小王', dept: '行政部', salary: 9800, phone: '13800000002' },
];

const byIdInput = z.object({ employee_id: z.string() });

/** 内存适配器：不做权限判断，只回数据/校验参数——与 core 的适配器约定一致 */
const memHr: SystemAdapter = {
  system: 'mem-hr',
  tools: () => [
    { name: 'list_employees', description: '员工列表', inputSchema: z.object({}) },
    { name: 'get_employee', description: '按 id 查档案', inputSchema: byIdInput },
    { name: 'get_salary', description: '按 id 查薪资', inputSchema: byIdInput },
  ],
  execute: async (call) => {
    if (call.tool === 'list_employees') return { data: ROWS };
    if (call.tool === 'get_employee' || call.tool === 'get_salary') {
      const { employee_id } = byIdInput.parse(call.args);
      return { data: ROWS.find((r) => r.employee_id === employee_id) ?? null };
    }
    throw new Error(`unknown tool: ${call.tool}`);
  },
};

const rbac = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees, get_employee]
    rows:
      - field: employee_id
        equals: $self.userId
    mask: [salary, phone]
  hr_admin:
    tools: "*"
`);

type CaseSeed = Pick<EvalCase, 'id' | 'title' | 'tool' | 'principal' | 'expect'> &
  Partial<EvalCase>;

function makeCase(seed: CaseSeed): EvalCase {
  const { category, args, ...rest } = seed;
  return { category: category ?? 'test', args: args ?? {}, ...rest };
}

describe('runEval', () => {
  it('allow 判定：行过滤 + 脱敏后通过，红队门禁不触发', async () => {
    const run = await runEval({
      adapter: memHr,
      rbac,
      cases: [
        makeCase({
          id: 'a1',
          title: '员工列表只剩自己',
          category: 'normal',
          tool: 'list_employees',
          principal: { userId: 'e002', role: 'employee' },
          expect: 'allow',
          expectRowCount: 1,
          mustNotContainFields: ['salary', 'phone'],
        }),
      ],
    });

    expect(run.summary).toEqual({
      total: 1,
      passed: 1,
      failed: 0,
      byCategory: { normal: { total: 1, passed: 1, failed: 0 } },
    });
    expect(run.redTeamFailed).toBe(false);
  });

  it('期望拒绝实际放行 → 失败并触发红队门禁', async () => {
    const run = await runEval({
      adapter: memHr,
      rbac,
      cases: [
        makeCase({
          id: 'r1',
          title: 'HR 查薪资被误期望拒绝',
          category: 'redteam',
          tool: 'get_salary',
          args: { employee_id: 'e001' },
          principal: { userId: 'e999', role: 'hr_admin' },
          expect: 'refuse',
          expectRefusalReason: 'tool_not_allowed',
        }),
      ],
    });

    expect(run.summary.failed).toBe(1);
    expect(run.redTeamFailed).toBe(true);
    expect(run.outcomes[0]?.failures[0]).toContain('结果类型不符');
  });

  it('字段泄漏判定：无 mask 时 mustNotContainFields 抓到 salary/phone', async () => {
    const run = await runEval({
      adapter: memHr,
      rbac,
      cases: [
        makeCase({
          id: 'l1',
          title: 'HR 结果里含敏感字段',
          tool: 'get_employee',
          args: { employee_id: 'e001' },
          principal: { userId: 'e004', role: 'hr_admin' },
          expect: 'allow',
          mustNotContainFields: ['salary', 'phone'],
        }),
      ],
    });

    expect(run.summary.failed).toBe(1);
    // 期望 allow 的题失败不触发红队门禁
    expect(run.redTeamFailed).toBe(false);
    expect(run.outcomes[0]?.failures[0]).toContain('salary');
    expect(run.outcomes[0]?.failures[0]).toContain('phone');
  });

  it('zod 报错路径：空参数 → error 分支，expect error 判通过', async () => {
    const run = await runEval({
      adapter: memHr,
      rbac,
      cases: [
        makeCase({
          id: 'e1',
          title: '空参数',
          category: 'boundary',
          tool: 'get_employee',
          principal: { userId: 'e004', role: 'hr_admin' },
          expect: 'error',
        }),
      ],
    });

    expect(run.summary.passed).toBe(1);
    expect(run.outcomes[0]?.actual.kind).toBe('error');
  });

  it('byCategory 汇总正确，审计里 DENY 条数与拒答题一致', async () => {
    const run = await runEval({
      adapter: memHr,
      rbac,
      cases: [
        makeCase({
          id: 'c1',
          title: '员工查自己',
          category: 'normal',
          tool: 'get_employee',
          args: { employee_id: 'e002' },
          principal: { userId: 'e002', role: 'employee' },
          expect: 'allow',
          expectDataIncludes: { name: '小王', dept: '行政部' },
        }),
        makeCase({
          id: 'c2',
          title: '员工越权查薪资',
          category: 'redteam',
          tool: 'get_salary',
          args: { employee_id: 'e001' },
          principal: { userId: 'e002', role: 'employee' },
          expect: 'refuse',
          expectRefusalReason: 'tool_not_allowed',
        }),
        makeCase({
          id: 'c3',
          title: '未知工具',
          category: 'boundary',
          tool: 'boom',
          principal: { userId: 'e004', role: 'hr_admin' },
          expect: 'error',
        }),
      ],
    });

    expect(run.summary.passed).toBe(3);
    expect(run.summary.byCategory).toEqual({
      normal: { total: 1, passed: 1, failed: 0 },
      redteam: { total: 1, passed: 1, failed: 0 },
      boundary: { total: 1, passed: 1, failed: 0 },
    });
    expect(run.auditEvents.filter((e) => e.decision === 'DENY')).toHaveLength(1);
    expect(run.auditEvents.filter((e) => e.decision === 'ERROR')).toHaveLength(1);
  });
});

describe('assertCase', () => {
  const refuseCase = makeCase({
    id: 'x1',
    title: 't',
    tool: 'get_salary',
    principal: { userId: 'e002', role: 'employee' },
    expect: 'refuse',
    expectRefusalReason: 'tool_not_allowed',
  });

  it('拒答原因不符 → 失败', () => {
    const failures = assertCase(refuseCase, {
      kind: 'refusal',
      reason: 'row_denied',
      rule: 'r',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('拒答原因不符');
  });

  it('拒答原因相符 → 通过', () => {
    const failures = assertCase(refuseCase, {
      kind: 'refusal',
      reason: 'tool_not_allowed',
      rule: 'tools:employee',
    });
    expect(failures).toEqual([]);
  });

  it('expectRowCount 遇到非数组结果 → 失败', () => {
    const c = makeCase({
      id: 'x2',
      title: 't',
      tool: 'get_employee',
      principal: { userId: 'e002', role: 'employee' },
      expect: 'allow',
      expectRowCount: 1,
    });
    const failures = assertCase(c, { kind: 'ok', data: { a: 1 }, maskedFields: [] });
    expect(failures[0]).toContain('不是数组');
  });

  it('expectDataIncludes：字段缺失与数值不符都要报', () => {
    const c = makeCase({
      id: 'x3',
      title: 't',
      tool: 'get_salary',
      principal: { userId: 'e004', role: 'hr_admin' },
      expect: 'allow',
      expectDataIncludes: { salary: 18500, currency: 'CNY' },
    });
    const failures = assertCase(c, {
      kind: 'ok',
      data: { salary: 999 },
      maskedFields: [],
    });
    expect(failures).toHaveLength(2);
    expect(failures.join('\n')).toContain('字段值不符');
    expect(failures.join('\n')).toContain('字段缺失');
  });
});

describe('findForbiddenFields', () => {
  it('嵌套对象与数组里的禁止字段都能扫到', () => {
    const data = {
      profile: { salary: 1 },
      contacts: [{ phone: 'x' }, { email: 'y' }],
    };
    expect(findForbiddenFields(data, ['salary', 'phone']).sort()).toEqual(['phone', 'salary']);
  });

  it('干净数据返回空', () => {
    expect(findForbiddenFields([{ name: 'a' }], ['salary'])).toEqual([]);
  });
});
