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

const twenty: SystemAdapter = {
  system: 'twenty',
  tools: () => ['list_accounts', 'get_opportunity'].map(spec),
  execute: async () => ({ data: null }),
};

const hrRbac = loadRbacConfig(`
roles:
  employee:
    tools: [list_employees, get_employee, get_leave_balance]
    rows:
      - { field: employee_id, equals: $self.userId }
    mask: [salary, phone]
  hr_admin:
    tools: "*"
`);

const crmRbac = loadRbacConfig(`
roles:
  sales_manager:
    tools: "*"
`);

const audit = new MemoryAuditLogger();
const systems = [
  { adapter: orangehrm, guard: new Guard(hrRbac, audit) },
  { adapter: twenty, guard: new Guard(crmRbac, audit) },
];

describe('allowedToolEntries', () => {
  it('employee 只注册白名单内 3 个工具，get_salary 连列表都不出现', () => {
    const names = allowedToolEntries(systems, { userId: 'e002', role: 'employee' }).map(
      (e) => e.spec.name,
    );
    expect(names).toEqual(['list_employees', 'get_employee', 'get_leave_balance']);
  });

  it('hr_admin（tools: "*"）注册 HR 全部 4 个工具——但通配不跨域，CRM 工具一个不带', () => {
    const names = allowedToolEntries(systems, { userId: 'e004', role: 'hr_admin' }).map(
      (e) => e.spec.name,
    );
    expect(names).toEqual(['list_employees', 'get_employee', 'get_leave_balance', 'get_salary']);
  });

  it('sales_manager（CRM 域通配）只见 CRM 的 2 个工具，HR 工具一个不带', () => {
    const names = allowedToolEntries(systems, { userId: 'e005', role: 'sales_manager' }).map(
      (e) => e.spec.name,
    );
    expect(names).toEqual(['list_accounts', 'get_opportunity']);
  });

  it('未知角色注册 0 个工具', () => {
    expect(allowedToolEntries(systems, { userId: 'x', role: 'intern' })).toEqual([]);
  });

  it('工具条目带回所属系统的守卫——按域裁决、按域审计的前提', () => {
    const entries = allowedToolEntries(systems, { userId: 'e005', role: 'sales_manager' });
    expect(entries.every((e) => e.adapter.system === 'twenty')).toBe(true);
    expect(entries.every((e) => e.guard === systems[1]?.guard)).toBe(true);
  });
});

describe('assertUniqueToolNames', () => {
  it('跨适配器同名工具在启动期抛错', () => {
    const clashing: SystemAdapter = {
      system: 'crm',
      tools: () => [spec('get_employee')],
      execute: async () => ({ data: null }),
    };
    expect(() => assertUniqueToolNames([orangehrm, clashing])).toThrow(/get_employee/);
  });

  it('无冲突时不抛', () => {
    expect(() => assertUniqueToolNames([orangehrm, twenty])).not.toThrow();
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
