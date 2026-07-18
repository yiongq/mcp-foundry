import { z } from 'zod';
import type {
  AccountDetail,
  AccountRow,
  ContactListRow,
  ContactRow,
  CreateContactInput,
  OpportunityRow,
  PipelineSummaryRow,
  TwentyBackend,
  UpdateContactPatch,
} from './backend.js';

/**
 * Twenty CRM REST 后端（Core API：/rest/ + Authorization: Bearer <API_KEY>）。
 *
 * Twenty 的字段是复合形状：person 姓名是 { firstName, lastName }，邮箱/电话是
 * 复合字段（emails.primaryEmail 等），jobTitle 是职务，company 是关系（companyId）。
 * 这里把它们翻译成扁平、逐字段命名的统一行结构，于是同一套守卫/工具/评测在
 * fixture 与真库两种后端上通用（守卫与后端无关）。
 *
 * 已对真实自托管 Twenty 实例验证（REST + Bearer，线上 crm.yiongspace.com）：
 * 响应包封形状（读 {data:{people:[…]}}、写 {data:{createPerson:{…}}}）、
 * amountMicros 为 JSON 字符串、owner 归属字段等实测坑记录在 docs/twenty-notes.md。
 * 单测用注入的 fetch 驱动，覆盖字段映射逻辑本身。
 */
export interface TwentyRestOptions {
  /** 形如 https://crm.example.com 或 https://api.twenty.com，尾部斜杠会被剥掉 */
  baseUrl: string;
  apiKey: string;
  /** owner_id 映射到 Twenty person/company/opportunity 上的哪个字段（需工作区自定义字段）。缺省 ownerId */
  ownerField?: string;
  /** 测试注入用；缺省全局 fetch */
  fetchImpl?: typeof fetch;
}

const nameObj = z.object({
  firstName: z.string().nullish(),
  lastName: z.string().nullish(),
});
const emailsObj = z.object({ primaryEmail: z.string().nullish() }).nullish();
const phonesObj = z.object({ primaryPhoneNumber: z.string().nullish() }).nullish();

function personSchema(ownerField: string) {
  return z
    .object({
      id: z.string(),
      name: nameObj.nullish(),
      jobTitle: z.string().nullish(),
      companyId: z.string().nullish(),
      emails: emailsObj,
      phones: phonesObj,
    })
    .passthrough()
    .transform((p) => ({ ...p, __owner: readOwner(p, ownerField) }));
}

function companySchema(ownerField: string) {
  return z
    .object({
      id: z.string(),
      name: z.string().nullish(),
      industry: z.string().nullish(),
      domainName: z.object({ primaryLinkUrl: z.string().nullish() }).nullish(),
      address: z.object({ addressCity: z.string().nullish() }).nullish(),
      phone: z.string().nullish(),
    })
    .passthrough()
    .transform((c) => ({ ...c, __owner: readOwner(c, ownerField) }));
}

function opportunitySchema(ownerField: string) {
  return z
    .object({
      id: z.string(),
      name: z.string().nullish(),
      companyId: z.string().nullish(),
      stage: z.string().nullish(),
      // Twenty 的 amountMicros 是 BigInt，JSON 里序列化成【字符串】——number|string 都收，读时再转
      amount: z.object({ amountMicros: z.union([z.number(), z.string()]).nullish() }).nullish(),
      closeDate: z.string().nullish(),
    })
    .passthrough()
    .transform((o) => ({ ...o, __owner: readOwner(o, ownerField) }));
}

function readOwner(record: Record<string, unknown>, ownerField: string): string {
  const v = record[ownerField];
  return typeof v === 'string' ? v : '';
}

function fullName(
  name:
    | { firstName?: string | null | undefined; lastName?: string | null | undefined }
    | null
    | undefined,
): string {
  // 空格拼接 firstName + lastName；本适配器写入时整名入 lastName、
  // firstName 为空，filter 会先抹掉空串，所以中文单名不会多出前导空格；真实拆分姓名读回带空格。
  return [name?.firstName, name?.lastName]
    .filter((s): s is string => !!s && s.trim() !== '')
    .join(' ');
}

export class TwentyRestBackend implements TwentyBackend {
  private readonly baseUrl: string;
  private readonly ownerField: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: TwentyRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.ownerField = options.ownerField ?? 'ownerId';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/rest${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`twenty REST ${method} ${path} 失败：HTTP ${res.status}`);
    }
    if (res.status === 204) return null;
    return (await res.json()) as unknown;
  }

  /** Twenty 列表包封 {data:{people:[…]}}；单条 {data:{person:{…}}}。两种都兜住，也兜 {data:[…]}/裸对象。 */
  private unwrapList(body: unknown, key: string): unknown[] {
    const data = (body as { data?: unknown })?.data ?? body;
    if (Array.isArray(data)) return data;
    const inner = (data as Record<string, unknown>)?.[key];
    return Array.isArray(inner) ? inner : [];
  }

  /**
   * 解开单条包封。GET 单条包在对象名单数键（person/company/opportunity），
   * 但**写操作包在操作名键**下（createPerson/updatePerson/updateOpportunity）——
   * 依次试给定候选键；都不中则退回「data 下唯一的对象值」（generically 兜住任何操作名键），
   * 再退回 data 本身（裸实体）。null（如 404/204）原样返回。
   */
  private unwrapOne(body: unknown, ...keys: string[]): unknown | null {
    if (body === null) return null;
    const data = (body as { data?: unknown })?.data ?? body;
    if (data === null || typeof data !== 'object') return data ?? null;
    const rec = data as Record<string, unknown>;
    for (const k of keys) {
      if (k in rec && rec[k] != null) return rec[k];
    }
    const objectValues = Object.values(rec).filter((v) => v != null && typeof v === 'object');
    if (objectValues.length === 1) return objectValues[0];
    return data;
  }

  private toContactRow(raw: unknown): ContactRow {
    const p = personSchema(this.ownerField).parse(raw);
    return {
      contact_id: p.id,
      name: fullName(p.name),
      title: p.jobTitle ?? '',
      account_id: p.companyId ?? '',
      owner_id: p.__owner,
      email: p.emails?.primaryEmail ?? '',
      phone: p.phones?.primaryPhoneNumber ?? '',
    };
  }

  private toAccountDetail(raw: unknown): AccountDetail {
    const c = companySchema(this.ownerField).parse(raw);
    return {
      account_id: c.id,
      name: c.name ?? '',
      industry: c.industry ?? '',
      owner_id: c.__owner,
      website: c.domainName?.primaryLinkUrl ?? '',
      phone: c.phone ?? '',
      city: c.address?.addressCity ?? '',
    };
  }

  private toOpportunityRow(raw: unknown): OpportunityRow {
    const o = opportunitySchema(this.ownerField).parse(raw);
    return {
      opportunity_id: o.id,
      name: o.name ?? '',
      account_id: o.companyId ?? '',
      stage: o.stage ?? '',
      // Twenty 金额是 amountMicros（百万分之一），可能是字符串，先归一成数再换算回元
      amount: o.amount?.amountMicros != null ? Number(o.amount.amountMicros) / 1_000_000 : 0,
      currency: 'CNY',
      probability: 0,
      close_date: o.closeDate ? o.closeDate.slice(0, 10) : '',
      owner_id: o.__owner,
    };
  }

  async listAccounts(industry?: string): Promise<AccountRow[]> {
    const rows = this.unwrapList(await this.request('GET', '/companies'), 'companies').map((r) =>
      this.toAccountDetail(r),
    );
    const filtered = industry === undefined ? rows : rows.filter((a) => a.industry === industry);
    return filtered.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      industry: a.industry,
      owner_id: a.owner_id,
    }));
  }

  async getAccount(accountId: string): Promise<AccountDetail | null> {
    const one = this.unwrapOne(
      await this.request('GET', `/companies/${encodeURIComponent(accountId)}`),
      'company',
    );
    return one === null ? null : this.toAccountDetail(one);
  }

  async listContacts(accountId?: string): Promise<ContactListRow[]> {
    const rows = this.unwrapList(await this.request('GET', '/people'), 'people').map((r) =>
      this.toContactRow(r),
    );
    const filtered =
      accountId === undefined ? rows : rows.filter((c) => c.account_id === accountId);
    return filtered.map((c) => ({
      contact_id: c.contact_id,
      name: c.name,
      title: c.title,
      account_id: c.account_id,
      owner_id: c.owner_id,
    }));
  }

  async getContact(contactId: string): Promise<ContactRow | null> {
    const one = this.unwrapOne(
      await this.request('GET', `/people/${encodeURIComponent(contactId)}`),
      'person',
    );
    return one === null ? null : this.toContactRow(one);
  }

  async listOpportunities(stage?: string): Promise<OpportunityRow[]> {
    const rows = this.unwrapList(await this.request('GET', '/opportunities'), 'opportunities').map(
      (r) => this.toOpportunityRow(r),
    );
    return stage === undefined ? rows : rows.filter((o) => o.stage === stage);
  }

  async getOpportunity(opportunityId: string): Promise<OpportunityRow | null> {
    const one = this.unwrapOne(
      await this.request('GET', `/opportunities/${encodeURIComponent(opportunityId)}`),
      'opportunity',
    );
    return one === null ? null : this.toOpportunityRow(one);
  }

  async getPipelineSummary(): Promise<PipelineSummaryRow[]> {
    // Twenty 无现成聚合端点，取全量商机在适配器侧现算——与 fixture 口径一致
    const opps = await this.listOpportunities();
    const byOwner = new Map<string, PipelineSummaryRow>();
    for (const o of opps) {
      const row = byOwner.get(o.owner_id) ?? {
        owner_id: o.owner_id,
        owner_name: o.owner_id,
        open_count: 0,
        open_amount: 0,
        won_count: 0,
        won_amount: 0,
      };
      if (o.stage === 'Closed Won') {
        row.won_count += 1;
        row.won_amount += o.amount;
      } else if (o.stage !== 'Closed Lost') {
        row.open_count += 1;
        row.open_amount += o.amount;
      }
      byOwner.set(o.owner_id, row);
    }
    return [...byOwner.values()].sort((a, b) => a.owner_id.localeCompare(b.owner_id));
  }

  private contactBody(
    input: {
      name?: string | undefined;
      title?: string | undefined;
      account_id?: string | undefined;
      email?: string | undefined;
      phone?: string | undefined;
    },
    owner?: string,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    if (input.name !== undefined) body.name = { firstName: '', lastName: input.name };
    if (input.title !== undefined) body.jobTitle = input.title;
    if (input.account_id !== undefined) body.companyId = input.account_id;
    if (input.email !== undefined) body.emails = { primaryEmail: input.email };
    if (input.phone !== undefined) body.phones = { primaryPhoneNumber: input.phone };
    if (owner !== undefined) body[this.ownerField] = owner;
    return body;
  }

  async createContact(input: CreateContactInput): Promise<ContactRow> {
    const body = await this.request('POST', '/people', this.contactBody(input, input.owner_id));
    const one = this.unwrapOne(body, 'createPerson', 'person');
    if (one === null) throw new Error('twenty REST 创建联系人未返回实体');
    return this.toContactRow(one);
  }

  async updateContact(contactId: string, patch: UpdateContactPatch): Promise<ContactRow | null> {
    const body = await this.request(
      'PATCH',
      `/people/${encodeURIComponent(contactId)}`,
      this.contactBody(patch),
    );
    const one = this.unwrapOne(body, 'updatePerson', 'person');
    return one === null ? null : this.toContactRow(one);
  }

  async deleteContact(contactId: string): Promise<ContactRow | null> {
    // 先取后删，返回被删的行（守卫行级过滤要看到 owner_id）
    const existing = await this.getContact(contactId);
    if (existing === null) return null;
    await this.request('DELETE', `/people/${encodeURIComponent(contactId)}`);
    return existing;
  }

  async updateOpportunityStage(
    opportunityId: string,
    stage: string,
  ): Promise<OpportunityRow | null> {
    const body = await this.request(
      'PATCH',
      `/opportunities/${encodeURIComponent(opportunityId)}`,
      { stage },
    );
    const one = this.unwrapOne(body, 'updateOpportunity', 'opportunity');
    return one === null ? null : this.toOpportunityRow(one);
  }
}
