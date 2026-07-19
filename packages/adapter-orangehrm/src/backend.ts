/**
 * 四个工具的统一行结构。字段名刻意用 snake_case——与 RBAC 行规则里的
 * field（如 employee_id）逐字对齐。
 */
export interface EmployeeRow {
  employee_id: string;
  name: string;
  dept: string;
  title: string;
}

export interface EmployeeDetail extends EmployeeRow {
  email: string;
  phone: string;
}

export interface LeaveBalanceRow {
  employee_id: string;
  name: string;
  annual_total: number;
  annual_used: number;
  annual_left: number;
}

export interface SalaryRow {
  employee_id: string;
  name: string;
  salary: number;
  currency: string;
  effective_date: string;
}

/** 数据来源抽象：当前仅 fixture（内置演示数据）后端；真实 OrangeHRM REST 后端曾存在，已随死代码清理移除。 */
export interface OrangeHrmBackend {
  listEmployees(dept?: string): Promise<EmployeeRow[]>;
  getEmployee(employeeId: string): Promise<EmployeeDetail | null>;
  getLeaveBalance(employeeId: string): Promise<LeaveBalanceRow | null>;
  getSalary(employeeId: string): Promise<SalaryRow | null>;
}
