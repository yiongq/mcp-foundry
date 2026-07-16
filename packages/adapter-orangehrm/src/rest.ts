import { z } from 'zod';
import type {
  EmployeeDetail,
  EmployeeRow,
  LeaveBalanceRow,
  OrangeHrmBackend,
  SalaryRow,
} from './backend.js';

/**
 * OrangeHRM Starter 5.x REST 后端。
 * 端点与字段映射基于公开 API v2 文档整理，未逐一实测——不确定项集中记录在
 * docs/orangehrm-api-notes.md（标注「待实测」），改动映射时先改那份笔记。
 */
export interface OrangeHrmRestOptions {
  /** 形如 http://localhost:8080，尾部斜杠会被剥掉 */
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  /** 测试注入用；缺省全局 fetch */
  fetchImpl?: typeof fetch;
  /** 员工列表分页大小，缺省 100 */
  pageSize?: number;
}

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().default(3600),
});

const listEnvelope = z.object({ data: z.array(z.unknown()) });
const itemEnvelope = z.object({ data: z.unknown() });

const idNameRef = z.object({
  id: z.union([z.string(), z.number()]).nullish(),
  name: z.string().nullish(),
});

const employeeItem = z.object({
  empNumber: z.number(),
  employeeId: z.string().nullish(),
  firstName: z.string().nullish(),
  middleName: z.string().nullish(),
  lastName: z.string().nullish(),
  jobTitle: z.object({ title: z.string().nullish() }).nullish(),
  subunit: idNameRef.nullish(),
});

const contactDetails = z.object({
  workEmail: z.string().nullish(),
  otherEmail: z.string().nullish(),
  workTelephone: z.string().nullish(),
  mobile: z.string().nullish(),
  homeTelephone: z.string().nullish(),
});

const entitlementItem = z.object({
  leaveType: idNameRef.nullish(),
  entitlement: z.union([z.string(), z.number()]).nullish(),
  // 已用天数的字段名两个候选都接（daysUsed/usedDays，待实测确认）
  daysUsed: z.union([z.string(), z.number()]).nullish(),
  usedDays: z.union([z.string(), z.number()]).nullish(),
});

const salaryComponentItem = z.object({
  amount: z.union([z.string(), z.number()]).nullish(),
  currencyType: idNameRef.nullish(),
});

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** OrangeHRM 姓名拆 first/middle/last 存储；中文录入顺序不统一，按原顺序拼接（见 api-notes） */
function joinName(...parts: (string | null | undefined)[]): string {
  return parts
    .filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    .join(' ')
    .trim();
}

function parseData<T>(body: unknown, schema: z.ZodType<T>): T | null {
  if (body === null || body === undefined) return null;
  const env = itemEnvelope.safeParse(body);
  if (!env.success) return null;
  const parsed = schema.safeParse(env.data.data);
  return parsed.success ? parsed.data : null;
}

export class OrangeHrmRestBackend implements OrangeHrmBackend {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;
  private token: { value: string; expiresAt: number } | null = null;
  /** 业务工号 employeeId → 内部主键 empNumber 与列表行缓存（端点都按 empNumber 寻址） */
  private readonly empIndex = new Map<string, { empNumber: number; row: EmployeeRow }>();

  constructor(private readonly options: OrangeHrmRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pageSize = options.pageSize ?? 100;
  }

  async listEmployees(dept?: string): Promise<EmployeeRow[]> {
    const rows = await this.fetchAllEmployees();
    return dept === undefined ? rows : rows.filter((r) => r.dept === dept);
  }

  async getEmployee(employeeId: string): Promise<EmployeeDetail | null> {
    const emp = await this.resolveEmp(employeeId);
    if (!emp) return null;
    const contact = parseData(
      await this.apiGet(`/pim/employees/${emp.empNumber}/contact-details`),
      contactDetails,
    );
    return {
      ...emp.row,
      email: contact?.workEmail ?? contact?.otherEmail ?? '',
      phone: contact?.workTelephone ?? contact?.mobile ?? contact?.homeTelephone ?? '',
    };
  }

  async getLeaveBalance(employeeId: string): Promise<LeaveBalanceRow | null> {
    const emp = await this.resolveEmp(employeeId);
    if (!emp) return null;
    const body = await this.apiGet(`/leave/leave-entitlements?empNumber=${emp.empNumber}&limit=50`);
    if (body === null) return null;
    const items: z.infer<typeof entitlementItem>[] = [];
    for (const raw of listEnvelope.parse(body).data) {
      const parsed = entitlementItem.safeParse(raw);
      if (parsed.success) items.push(parsed.data);
    }
    // 优先取名称含 Annual/年假 的假种；没有就退回第一条
    const picked = items.find((i) => /annual|年假/i.test(i.leaveType?.name ?? '')) ?? items[0];
    const total = toNumber(picked?.entitlement) ?? 0;
    const used = toNumber(picked?.daysUsed) ?? toNumber(picked?.usedDays) ?? 0;
    return {
      employee_id: employeeId,
      name: emp.row.name,
      annual_total: total,
      annual_used: used,
      annual_left: total - used,
    };
  }

  async getSalary(employeeId: string): Promise<SalaryRow | null> {
    const emp = await this.resolveEmp(employeeId);
    if (!emp) return null;
    const body = await this.apiGet(`/pim/employees/${emp.empNumber}/salary-components?limit=50`);
    if (body === null) return null;
    for (const raw of listEnvelope.parse(body).data) {
      const parsed = salaryComponentItem.safeParse(raw);
      if (!parsed.success) continue;
      const amount = toNumber(parsed.data.amount);
      if (amount === null) continue;
      return {
        employee_id: employeeId,
        name: emp.row.name,
        salary: amount,
        currency: String(parsed.data.currencyType?.id ?? parsed.data.currencyType?.name ?? ''),
        // OrangeHRM 薪资组件没有生效日期字段，REST 模式此处只能给空串（见 api-notes）
        effective_date: '',
      };
    }
    return null;
  }

  private async resolveEmp(
    employeeId: string,
  ): Promise<{ empNumber: number; row: EmployeeRow } | null> {
    const hit = this.empIndex.get(employeeId);
    if (hit) return hit;
    await this.fetchAllEmployees();
    return this.empIndex.get(employeeId) ?? null;
  }

  private async fetchAllEmployees(): Promise<EmployeeRow[]> {
    const rows: EmployeeRow[] = [];
    for (let offset = 0; ; offset += this.pageSize) {
      const body = await this.apiGet(
        `/pim/employees?model=detailed&limit=${this.pageSize}&offset=${offset}`,
      );
      if (body === null) break;
      const { data } = listEnvelope.parse(body);
      for (const raw of data) {
        const parsed = employeeItem.safeParse(raw);
        if (!parsed.success) continue;
        const e = parsed.data;
        const row: EmployeeRow = {
          employee_id: e.employeeId ?? String(e.empNumber),
          name: joinName(e.firstName, e.middleName, e.lastName),
          dept: e.subunit?.name ?? '',
          title: e.jobTitle?.title ?? '',
        };
        this.empIndex.set(row.employee_id, { empNumber: e.empNumber, row });
        rows.push(row);
      }
      if (data.length < this.pageSize) break;
    }
    return rows;
  }

  private async accessToken(): Promise<string> {
    // 提前 30s 视为过期，避免边界上带着将失效的 token 发请求
    if (this.token && Date.now() < this.token.expiresAt - 30_000) return this.token.value;
    const res = await this.fetchImpl(`${this.baseUrl}/web/index.php/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.options.clientId,
        client_secret: this.options.clientSecret,
      }).toString(),
    });
    if (!res.ok) {
      throw new Error(`orangehrm oauth2 token 获取失败: HTTP ${res.status}`);
    }
    const parsed = tokenSchema.parse(await res.json());
    this.token = { value: parsed.access_token, expiresAt: Date.now() + parsed.expires_in * 1000 };
    return parsed.access_token;
  }

  /** GET /web/index.php/api/v2 下的端点；404 归一化为 null（"查不到"不算错误） */
  private async apiGet(path: string): Promise<unknown> {
    const token = await this.accessToken();
    const res = await this.fetchImpl(`${this.baseUrl}/web/index.php/api/v2${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`orangehrm api ${path} 请求失败: HTTP ${res.status}`);
    }
    return res.json();
  }
}
