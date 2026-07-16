import { createMemoryAdapter, MemoryStore } from '@yiong/foundry-adapter-memory';
import { createOrangeHrmAdapter } from '@yiong/foundry-adapter-orangehrm';
import type { Principal, SystemAdapter } from '@yiong/foundry-core';
import { Guard, loadRbacConfig, MemoryAuditLogger } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GuardedToolset } from './toolset.js';

const rbacHr = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees, get_employee, get_leave_balance]
    rows:
      - field: employee_id
        equals: $self.userId
    mask: [salary, phone]
  hr_admin:
    tools: "*"
`);

const rbacMemory = loadRbacConfig(`
roles:
  employee:
    tools: [save_memory, recall_memories, get_memory]
    rows:
      - field: employee_id
        equals: $self.userId
  hr_admin:
    tools: [save_memory, recall_memories, get_memory]
    rows:
      - field: employee_id
        equals: $self.userId
`);

function buildToolset(): GuardedToolset {
  const audit = new MemoryAuditLogger();
  return new GuardedToolset([
    { adapter: createOrangeHrmAdapter({ env: {} }), guard: new Guard(rbacHr, audit) },
    { adapter: createMemoryAdapter(new MemoryStore()), guard: new Guard(rbacMemory, audit) },
  ]);
}

const XIAO_WANG: Principal = { userId: 'e002', role: 'employee' };
const LAO_LI: Principal = { userId: 'e004', role: 'hr_admin' };

describe('GuardedToolset', () => {
  it('工具面按身份收窄：员工看不到 get_salary，HR 全量；JSON Schema 形状正确', () => {
    const toolset = buildToolset();

    const employeeTools = toolset.allowedTools(XIAO_WANG).map((t) => t.name);
    expect(employeeTools).toEqual([
      'list_employees',
      'get_employee',
      'get_leave_balance',
      'save_memory',
      'recall_memories',
      'get_memory',
    ]);

    const hrTools = toolset.allowedTools(LAO_LI).map((t) => t.name);
    expect(hrTools).toContain('get_salary');

    const getEmployee = toolset.allowedTools(LAO_LI).find((t) => t.name === 'get_employee');
    expect(getEmployee?.parameters).toMatchObject({
      type: 'object',
      properties: { employee_id: { type: 'string' } },
    });
    expect(getEmployee?.parameters).not.toHaveProperty('$schema');
  });

  it('未知角色的工具面为空数组', () => {
    const toolset = buildToolset();
    expect(toolset.allowedTools({ userId: 'x', role: 'ghost' })).toEqual([]);
  });

  it('invoke 按名路由：跨系统各自走各自的守卫与 RBAC', async () => {
    const toolset = buildToolset();

    // 业务域：员工越权查薪资 → tool_not_allowed
    const salary = await toolset.invoke(XIAO_WANG, 'get_salary', { employee_id: 'e002' });
    expect(salary.kind).toBe('refusal');

    // 记忆域：HR 存自己的记忆 → ok 且归属正确（hr_admin 在记忆域不搞特殊）
    const saved = await toolset.invoke(LAO_LI, 'save_memory', { content: '周五复盘' });
    expect(saved.kind).toBe('ok');
    if (saved.kind === 'ok') {
      expect((saved.data as { employee_id: string }).employee_id).toBe('e004');
    }

    // 未知工具 → error 分支不抛
    const unknown = await toolset.invoke(LAO_LI, 'fire_employee', {});
    expect(unknown.kind).toBe('error');
  });

  it('跨系统工具撞名在构造期抛错', () => {
    const dup: SystemAdapter = {
      system: 'dup',
      tools: () => [{ name: 'get_employee', description: 'x', inputSchema: z.object({}) }],
      execute: async () => ({ data: null }),
    };
    const audit = new MemoryAuditLogger();
    expect(
      () =>
        new GuardedToolset([
          { adapter: createOrangeHrmAdapter({ env: {} }), guard: new Guard(rbacHr, audit) },
          { adapter: dup, guard: new Guard(rbacHr, audit) },
        ]),
    ).toThrow(/冲突/);
  });
});
