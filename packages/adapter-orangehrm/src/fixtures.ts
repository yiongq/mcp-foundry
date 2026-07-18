import type {
  EmployeeDetail,
  EmployeeRow,
  LeaveBalanceRow,
  OrangeHrmBackend,
  SalaryRow,
} from './backend.js';

export interface FixtureEmployee extends EmployeeDetail {
  salary: number;
  annual_used: number;
}

const ANNUAL_TOTAL = 10;
const CURRENCY = 'CNY';
const EFFECTIVE_DATE = '2026-01-01';

/** 演示与评测共用的 6 人名单——数值被评测题面引用，不要改动。 */
export const FIXTURE_EMPLOYEES: readonly FixtureEmployee[] = [
  {
    employee_id: 'e001',
    name: '张三',
    dept: '生产部',
    title: '设备工程师',
    email: 'zhangsan@example.com',
    phone: '13800000001',
    salary: 18500,
    annual_used: 6,
  },
  {
    employee_id: 'e002',
    name: '小王',
    dept: '行政部',
    title: '行政专员',
    email: 'xiaowang@example.com',
    phone: '13800000002',
    salary: 9800,
    annual_used: 3,
  },
  {
    employee_id: 'e003',
    name: '李四',
    dept: '生产部',
    title: '班组长',
    email: 'lisi@example.com',
    phone: '13800000003',
    salary: 15200,
    annual_used: 5,
  },
  {
    employee_id: 'e004',
    name: '老李',
    dept: '人事部',
    title: 'HR主管',
    email: 'laoli@example.com',
    phone: '13800000004',
    salary: 22000,
    annual_used: 2,
  },
  {
    employee_id: 'e005',
    name: '何静',
    dept: '商务部',
    title: '商务经理',
    email: 'hejing@example.com',
    phone: '13800000005',
    salary: 16800,
    annual_used: 4,
  },
  {
    employee_id: 'e006',
    name: '赵六',
    dept: '研发中心',
    title: '前端工程师',
    email: 'zhaoliu@example.com',
    phone: '13800000006',
    salary: 21000,
    annual_used: 1,
  },
];

export class FixtureBackend implements OrangeHrmBackend {
  async listEmployees(dept?: string): Promise<EmployeeRow[]> {
    const rows =
      dept === undefined ? FIXTURE_EMPLOYEES : FIXTURE_EMPLOYEES.filter((e) => e.dept === dept);
    return rows.map((e) => ({
      employee_id: e.employee_id,
      name: e.name,
      dept: e.dept,
      title: e.title,
    }));
  }

  async getEmployee(employeeId: string): Promise<EmployeeDetail | null> {
    const e = FIXTURE_EMPLOYEES.find((x) => x.employee_id === employeeId);
    if (!e) return null;
    return {
      employee_id: e.employee_id,
      name: e.name,
      dept: e.dept,
      title: e.title,
      email: e.email,
      phone: e.phone,
    };
  }

  async getLeaveBalance(employeeId: string): Promise<LeaveBalanceRow | null> {
    const e = FIXTURE_EMPLOYEES.find((x) => x.employee_id === employeeId);
    if (!e) return null;
    return {
      employee_id: e.employee_id,
      name: e.name,
      annual_total: ANNUAL_TOTAL,
      annual_used: e.annual_used,
      annual_left: ANNUAL_TOTAL - e.annual_used,
    };
  }

  async getSalary(employeeId: string): Promise<SalaryRow | null> {
    const e = FIXTURE_EMPLOYEES.find((x) => x.employee_id === employeeId);
    if (!e) return null;
    return {
      employee_id: e.employee_id,
      name: e.name,
      salary: e.salary,
      currency: CURRENCY,
      effective_date: EFFECTIVE_DATE,
    };
  }
}
