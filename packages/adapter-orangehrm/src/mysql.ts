import type {
  EmployeeDetail,
  EmployeeRow,
  LeaveBalanceRow,
  OrangeHrmBackend,
  SalaryRow,
} from './backend.js';

/**
 * 只读直连 MySQL 后端（OrangeHRM 5.7 真实库表，见 docs/orangehrm-db-schema.md）。
 * 为什么不走 REST：OrangeHRM OS 版的 OAuth 只启用 AuthCode+RefreshToken，
 * 服务对服务的 client_credentials 不支持（docs/orangehrm-api-notes.md 实测）。
 *
 * 只读纪律（层层兜底）：
 * 1. 连接账号是 SELECT-only 的专用用户（foundry_ro）——数据库侧强制，代码绕不过；
 * 2. 全部 SQL 是静态字符串 + 参数占位，没有任何拼接——注入面在结构上不存在；
 * 3. 每条查询显式 LIMIT。
 *
 * 精确匹配纪律：employee_id / 部门名比较一律走 CAST(... AS BINARY) 字节比较——
 * OrangeHRM 的列是 utf8mb3_general_ci（大小写不敏感），真库评测抓到过
 * 「E002 变造命中 e002 行」，与 fixture 的精确匹配语义不同构（r12 题）。
 * 不用 COLLATE：utf8mb4_bin 套不上 utf8mb3 列（真库评测第二轮抓到的报错），
 * BINARY 字节比较与列字符集无关，utf8mb3/utf8mb4 的 BMP 字符字节一致。
 */
export interface MySqlBackendOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** 年假的 leave_type 名称；演示库种子数据用「年假」 */
  leaveTypeName?: string;
  /** 测试注入用：替换真实连接池 */
  executor?: SqlExecutor;
}

export interface SqlExecutor {
  query(sql: string, params: ReadonlyArray<string>): Promise<Array<Record<string, unknown>>>;
  end(): Promise<void>;
}

/** 姓名拼接：中文整名存 emp_firstname、姓氏列留空（种子数据约定），西式拆分名同样兼容（姓在前）。 */
const NAME_EXPR = 'TRIM(CONCAT(e.emp_lastname, e.emp_firstname, e.emp_middle_name))';

const LIST_SQL = `
SELECT e.employee_id, ${NAME_EXPR} AS name,
       COALESCE(s.name, '') AS dept, COALESCE(j.job_title, '') AS title
FROM hs_hr_employee e
LEFT JOIN ohrm_subunit s ON s.id = e.work_station
LEFT JOIN ohrm_job_title j ON j.id = e.job_title_code AND j.is_deleted = 0
WHERE e.termination_id IS NULL AND e.employee_id IS NOT NULL AND e.employee_id <> ''`;

const LIST_DEPT_FILTER = ' AND CAST(s.name AS BINARY) = CAST(? AS BINARY)';
const LIST_ORDER = ' ORDER BY e.employee_id LIMIT 500';

const DETAIL_SQL = `
SELECT e.employee_id, ${NAME_EXPR} AS name,
       COALESCE(s.name, '') AS dept, COALESCE(j.job_title, '') AS title,
       COALESCE(e.emp_work_email, e.emp_oth_email, '') AS email,
       COALESCE(e.emp_work_telephone, e.emp_mobile, e.emp_hm_telephone, '') AS phone
FROM hs_hr_employee e
LEFT JOIN ohrm_subunit s ON s.id = e.work_station
LEFT JOIN ohrm_job_title j ON j.id = e.job_title_code AND j.is_deleted = 0
WHERE e.termination_id IS NULL AND CAST(e.employee_id AS BINARY) = CAST(? AS BINARY)
LIMIT 1`;

// 薪资金额列是 varchar，多条记录取最新一条（id 最大）
const SALARY_SQL = `
SELECT e.employee_id, ${NAME_EXPR} AS name,
       b.ebsal_basic_salary AS salary, b.currency_id AS currency
FROM hs_hr_employee e
JOIN hs_hr_emp_basicsalary b ON b.emp_number = e.emp_number
WHERE e.termination_id IS NULL AND CAST(e.employee_id AS BINARY) = CAST(? AS BINARY)
ORDER BY b.id DESC
LIMIT 1`;

const LEAVE_SQL = `
SELECT e.employee_id, ${NAME_EXPR} AS name,
       le.no_of_days AS annual_total, le.days_used AS annual_used
FROM hs_hr_employee e
JOIN ohrm_leave_entitlement le ON le.emp_number = e.emp_number AND le.deleted = 0
JOIN ohrm_leave_type lt ON lt.id = le.leave_type_id AND lt.deleted = 0 AND lt.name = ?
WHERE e.termination_id IS NULL AND CAST(e.employee_id AS BINARY) = CAST(? AS BINARY)
ORDER BY le.id DESC
LIMIT 1`;

export class MySqlOrangeHrmBackend implements OrangeHrmBackend {
  private executor: SqlExecutor | null;
  private readonly leaveTypeName: string;

  constructor(private readonly options: MySqlBackendOptions) {
    this.executor = options.executor ?? null;
    this.leaveTypeName = options.leaveTypeName ?? '年假';
  }

  /** 连接池按需惰性创建——单测注入 executor 时永不触碰真实网络 */
  private async getExecutor(): Promise<SqlExecutor> {
    if (this.executor !== null) return this.executor;
    const { createPool } = await import('mysql2/promise');
    const pool = createPool({
      host: this.options.host,
      port: this.options.port,
      database: this.options.database,
      user: this.options.user,
      password: this.options.password,
      // 客户端默认 charset 不是 utf8mb4 时中文参数/结果会被转码坏——显式钉死
      charset: 'utf8mb4',
      connectionLimit: 4,
    });
    this.executor = {
      query: async (sql, params) => {
        const [rows] = await pool.execute(sql, [...params]);
        return rows as Array<Record<string, unknown>>;
      },
      end: () => pool.end(),
    };
    return this.executor;
  }

  /** 评测/脚本收尾用；不关连接 Node 进程不退出 */
  async end(): Promise<void> {
    if (this.executor !== null) await this.executor.end();
  }

  async listEmployees(dept?: string): Promise<EmployeeRow[]> {
    const executor = await this.getExecutor();
    const sql =
      dept === undefined
        ? `${LIST_SQL}${LIST_ORDER}`
        : `${LIST_SQL}${LIST_DEPT_FILTER}${LIST_ORDER}`;
    const rows = await executor.query(sql, dept === undefined ? [] : [dept]);
    return rows.map((row) => ({
      employee_id: String(row.employee_id),
      name: String(row.name),
      dept: String(row.dept),
      title: String(row.title),
    }));
  }

  async getEmployee(employeeId: string): Promise<EmployeeDetail | null> {
    const executor = await this.getExecutor();
    const rows = await executor.query(DETAIL_SQL, [employeeId]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      employee_id: String(row.employee_id),
      name: String(row.name),
      dept: String(row.dept),
      title: String(row.title),
      email: String(row.email),
      phone: String(row.phone),
    };
  }

  async getSalary(employeeId: string): Promise<SalaryRow | null> {
    const executor = await this.getExecutor();
    const rows = await executor.query(SALARY_SQL, [employeeId]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      employee_id: String(row.employee_id),
      name: String(row.name),
      // 源列是 varchar；非数字内容宁可 NaN 显形，不静默造数
      salary: Number(row.salary),
      currency: String(row.currency),
      // basicsalary 表没有生效日期列（REST 后端同样返回空串）
      effective_date: '',
    };
  }

  async getLeaveBalance(employeeId: string): Promise<LeaveBalanceRow | null> {
    const executor = await this.getExecutor();
    const rows = await executor.query(LEAVE_SQL, [this.leaveTypeName, employeeId]);
    const row = rows[0];
    if (row === undefined) return null;
    const total = Number(row.annual_total);
    const used = Number(row.annual_used);
    return {
      employee_id: String(row.employee_id),
      name: String(row.name),
      annual_total: total,
      annual_used: used,
      annual_left: total - used,
    };
  }
}
