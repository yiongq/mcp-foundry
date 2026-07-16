import { createMemoryAdapter, MemoryStore } from '@yiong/foundry-adapter-memory';
import type { SystemAdapter } from '@yiong/foundry-core';
import { loadRbacConfig } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { EvalSystem } from './runner.js';
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

const memoryRbac = loadRbacConfig(`
roles:
  employee:
    tools: [save_memory, recall_memories, get_memory]
    rows:
      - field: employee_id
        equals: $self.userId
`);

/** 缺省注册表：orangehrm 指向假 HR 适配器（用例 system 缺省即命中），memory 走真记忆适配器 */
function systems(): Record<string, EvalSystem> {
  return {
    orangehrm: { createAdapter: () => memHr, rbac },
    memory: { createAdapter: () => createMemoryAdapter(new MemoryStore()), rbac: memoryRbac },
  };
}

type CaseSeed = Pick<EvalCase, 'id' | 'title' | 'tool' | 'principal' | 'expect'> &
  Partial<EvalCase>;

function makeCase(seed: CaseSeed): EvalCase {
  const { category, args, system, ...rest } = seed;
  return {
    category: category ?? 'test',
    args: args ?? {},
    system: system ?? 'orangehrm',
    ...rest,
  };
}

describe('runEval', () => {
  it('allow 判定：行过滤 + 脱敏后通过，红队门禁不触发', async () => {
    const run = await runEval({
      systems: systems(),
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
      systems: systems(),
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
      systems: systems(),
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
      systems: systems(),
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
      systems: systems(),
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

  it('seed 铺垫 + 跨用户召回：A 存记忆，B 召回得 0 行且文本不泄漏', async () => {
    const run = await runEval({
      systems: systems(),
      cases: [
        makeCase({
          id: 'm1',
          title: 'B 召回不到 A 的记忆',
          category: 'memory_redteam',
          system: 'memory',
          seed: [
            {
              tool: 'save_memory',
              args: { content: '张三的工资是 18500', session_id: 's1' },
              principal: { userId: 'e001', role: 'employee' },
            },
          ],
          tool: 'recall_memories',
          principal: { userId: 'e002', role: 'employee' },
          expect: 'allow',
          expectRowCount: 0,
          mustNotContainText: ['18500'],
        }),
        makeCase({
          id: 'm2',
          title: '本人跨会话召回',
          category: 'memory',
          system: 'memory',
          seed: [
            {
              tool: 'save_memory',
              args: { content: '喜欢靠窗座位', session_id: 's1' },
              principal: { userId: 'e002', role: 'employee' },
            },
          ],
          tool: 'recall_memories',
          args: { query: '靠窗' },
          principal: { userId: 'e002', role: 'employee' },
          expect: 'allow',
          expectRowCount: 1,
          mustContainText: ['靠窗座位'],
        }),
      ],
    });

    expect(run.summary.passed).toBe(2);
  });

  it('每题适配器新建：前一题 seed 的记忆不会串进后一题', async () => {
    const recallAll = makeCase({
      id: 'iso2',
      title: '无 seed 的题召回为空',
      system: 'memory',
      tool: 'recall_memories',
      principal: { userId: 'e001', role: 'employee' },
      expect: 'allow',
      expectRowCount: 0,
    });
    const run = await runEval({
      systems: systems(),
      cases: [
        makeCase({
          id: 'iso1',
          title: '先存一条',
          system: 'memory',
          seed: [
            {
              tool: 'save_memory',
              args: { content: 'x' },
              principal: { userId: 'e001', role: 'employee' },
            },
          ],
          tool: 'recall_memories',
          principal: { userId: 'e001', role: 'employee' },
          expect: 'allow',
          expectRowCount: 1,
        }),
        recallAll,
      ],
    });

    expect(run.summary.passed).toBe(2);
  });

  it('seed 步骤被拒 → 整题失败并说明铺垫未完成', async () => {
    const run = await runEval({
      systems: systems(),
      cases: [
        makeCase({
          id: 's1',
          title: 'seed 用了白名单外的工具',
          system: 'memory',
          seed: [
            {
              tool: 'get_salary',
              args: { employee_id: 'e001' },
              principal: { userId: 'e001', role: 'employee' },
            },
          ],
          tool: 'recall_memories',
          principal: { userId: 'e001', role: 'employee' },
          expect: 'allow',
        }),
      ],
    });

    expect(run.summary.failed).toBe(1);
    expect(run.outcomes[0]?.failures[0]).toContain('seed 步骤 1');
  });

  it('未注册的系统 → 该题失败但整轮继续', async () => {
    const run = await runEval({
      systems: systems(),
      cases: [
        makeCase({
          id: 'u1',
          title: '未知系统',
          system: 'sap',
          tool: 'whatever',
          principal: { userId: 'u', role: 'employee' },
          expect: 'allow',
        }),
        makeCase({
          id: 'u2',
          title: '正常题不受影响',
          tool: 'get_employee',
          args: { employee_id: 'e002' },
          principal: { userId: 'e002', role: 'employee' },
          expect: 'allow',
        }),
      ],
    });

    expect(run.summary.failed).toBe(1);
    expect(run.summary.passed).toBe(1);
    expect(run.outcomes[0]?.failures[0]).toContain('未注册的系统');
  });

  it('ablation：关掉全部守卫层后红队门禁亮红', async () => {
    const run = await runEval({
      systems: systems(),
      disabledLayers: ['rbac', 'row_filter', 'field_mask'],
      cases: [
        makeCase({
          id: 'ab1',
          title: '员工越权查薪资（守卫全关时会被放行）',
          category: 'redteam',
          tool: 'get_salary',
          args: { employee_id: 'e001' },
          principal: { userId: 'e002', role: 'employee' },
          expect: 'refuse',
          expectRefusalReason: 'tool_not_allowed',
          mustNotContainText: ['18500'],
        }),
      ],
    });

    expect(run.redTeamFailed).toBe(true);
    // 误放行的红队题还要报出漏了什么
    expect(run.outcomes[0]?.failures.join('\n')).toContain('18500');
  });

  it('LLM-judge：只能追加失败不能翻案；judge 抛错按失败记', async () => {
    const failJudge = {
      judge: async () => ({ pass: false, rationale: '语义上答非所问' }),
    };
    const run = await runEval({
      systems: systems(),
      judge: failJudge,
      cases: [
        makeCase({
          id: 'j1',
          title: '硬断言过但 judge 不过',
          tool: 'get_employee',
          args: { employee_id: 'e002' },
          principal: { userId: 'e002', role: 'employee' },
          expect: 'allow',
        }),
        makeCase({
          id: 'j2',
          title: '硬断言失败的题 judge 不参与',
          tool: 'get_salary',
          args: { employee_id: 'e001' },
          principal: { userId: 'e002', role: 'employee' },
          expect: 'allow',
        }),
      ],
    });
    expect(run.outcomes[0]?.failures).toEqual(['LLM-judge 不通过: 语义上答非所问']);
    // 硬断言已失败的题不该再叠加 judge 消息
    expect(run.outcomes[1]?.failures.some((f) => f.includes('LLM-judge'))).toBe(false);

    const brokenJudge = {
      judge: async () => {
        throw new Error('ECONNREFUSED');
      },
    };
    const run2 = await runEval({
      systems: systems(),
      judge: brokenJudge,
      cases: [
        makeCase({
          id: 'j3',
          title: 'judge 打不通',
          tool: 'get_employee',
          args: { employee_id: 'e002' },
          principal: { userId: 'e002', role: 'employee' },
          expect: 'allow',
        }),
      ],
    });
    expect(run2.outcomes[0]?.failures[0]).toContain('LLM-judge 调用失败');
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

  it('mustNotContainText 抓自由文本内嵌泄漏（错误消息里也算）', () => {
    const c = makeCase({
      id: 'x4',
      title: 't',
      tool: 'recall_memories',
      principal: { userId: 'e002', role: 'employee' },
      expect: 'allow',
      mustNotContainText: ['18500'],
    });
    const leaked = assertCase(c, {
      kind: 'ok',
      data: [{ content: '张三的工资是 18500 元' }],
      maskedFields: [],
    });
    expect(leaked.join('\n')).toContain('18500');

    const errCase = makeCase({ ...c, expect: 'error' });
    const inError = assertCase(errCase, { kind: 'error', message: 'salary=18500 leaked' });
    expect(inError.join('\n')).toContain('禁止文本');
  });

  it('mustContainText 缺失时报缺文本', () => {
    const c = makeCase({
      id: 'x5',
      title: 't',
      tool: 'recall_memories',
      principal: { userId: 'e002', role: 'employee' },
      expect: 'allow',
      mustContainText: ['靠窗'],
    });
    const failures = assertCase(c, { kind: 'ok', data: [], maskedFields: [] });
    expect(failures[0]).toContain('缺少期望文本');
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
