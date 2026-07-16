/**
 * 四个工具的统一行结构（fixture 与 REST 两个后端都必须映射到这套形状）。
 * 字段名刻意用 snake_case——与 RBAC 行规则里的 field（如 employee_id）逐字对齐。
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

/** 数据来源抽象：fixture（内置演示数据）与 REST（真实 OrangeHRM）各实现一份。 */
export interface OrangeHrmBackend {
  listEmployees(dept?: string): Promise<EmployeeRow[]>;
  getEmployee(employeeId: string): Promise<EmployeeDetail | null>;
  getLeaveBalance(employeeId: string): Promise<LeaveBalanceRow | null>;
  getSalary(employeeId: string): Promise<SalaryRow | null>;
}
