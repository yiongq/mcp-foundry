import type { ToolSpec } from '@yiong/foundry-core';
import { z } from 'zod';

export const listEmployeesInput = z.object({
  dept: z.string().min(1).optional(),
});

export const employeeIdInput = z.object({
  employee_id: z.string().min(1),
});

export const TOOL_SPECS: readonly ToolSpec[] = [
  {
    name: 'list_employees',
    description:
      '列出员工花名册，可选按部门名称（dept）精确过滤；每行含 employee_id、name、dept、title',
    inputSchema: listEmployeesInput,
  },
  {
    name: 'get_employee',
    description: '按 employee_id 查询单个员工的基本信息（含 email、phone）；员工不存在时返回 null',
    inputSchema: employeeIdInput,
  },
  {
    name: 'get_leave_balance',
    description:
      '按 employee_id 查询年假余额（annual_total/annual_used/annual_left）；员工不存在时返回 null',
    inputSchema: employeeIdInput,
  },
  {
    name: 'get_salary',
    description: '按 employee_id 查询薪资（salary/currency/effective_date）；员工不存在时返回 null',
    inputSchema: employeeIdInput,
  },
];
