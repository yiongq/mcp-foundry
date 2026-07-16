import type { SystemAdapter, ToolSpec } from '@yiong/foundry-core';
import { Guard, loadRbacConfig, MemoryAuditLogger } from '@yiong/foundry-core';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { allowedToolEntries, assertUniqueToolNames, toRawShape } from './registry.js';

const spec = (name: string): ToolSpec => ({ name, description: name, inputSchema: z.object({}) });

const orangehrm: SystemAdapter = {
  system: 'orangehrm',
  tools: () => ['list_employees', 'get_employee', 'get_leave_balance', 'get_salary'].map(spec),
  execute: async () => ({ data: null }),
};

const rbac = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees, get_employee, get_leave_balance]
    rows:
      - { field: employee_id, equals: $self.userId }
    mask: [salary, phone]
  hr_admin:
    tools: "*"
`);

const guard = new Guard(rbac, new MemoryAuditLogger());

describe('allowedToolEntries', () => {
  it('employee 只注册白名单内 3 个工具，get_salary 连列表都不出现', () => {
    const names = allowedToolEntries([orangehrm], guard, { userId: 'e002', role: 'employee' }).map(
      (e) => e.spec.name,
    );
    expect(names).toEqual(['list_employees', 'get_employee', 'get_leave_balance']);
  });

  it('hr_admin（tools: "*"）注册全部 4 个工具', () => {
    const names = allowedToolEntries([orangehrm], guard, { userId: 'e004', role: 'hr_admin' }).map(
      (e) => e.spec.name,
    );
    expect(names).toEqual(['list_employees', 'get_employee', 'get_leave_balance', 'get_salary']);
  });

  it('未知角色注册 0 个工具', () => {
    expect(allowedToolEntries([orangehrm], guard, { userId: 'x', role: 'intern' })).toEqual([]);
  });
});

describe('assertUniqueToolNames', () => {
  it('跨适配器同名工具在启动期抛错', () => {
    const crm: SystemAdapter = {
      system: 'crm',
      tools: () => [spec('get_employee')],
      execute: async () => ({ data: null }),
    };
    expect(() => assertUniqueToolNames([orangehrm, crm])).toThrow(/get_employee/);
  });

  it('无冲突时不抛', () => {
    expect(() => assertUniqueToolNames([orangehrm])).not.toThrow();
  });
});

describe('toRawShape', () => {
  it('z.object → raw shape', () => {
    const shape = toRawShape(z.object({ dept: z.string().optional() }), 'list_employees');
    expect(Object.keys(shape)).toEqual(['dept']);
  });

  it('非对象 schema 抛错并带上工具名', () => {
    expect(() => toRawShape(z.string(), 'bad_tool')).toThrow(/bad_tool/);
  });
});
