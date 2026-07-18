import { z } from 'zod';
import type {
  ContactRow,
  CreateContactInput,
  OpportunityRow,
  UpdateContactPatch,
} from './backend.js';

/**
 * EspoCRM REST 写通道（API 用户 + X-Api-Key 头，服务端对服务端无需 OAuth）。
 * 只承担写方法——读路径继续走 fixture/只读 MySQL，由 withRestWrites 组合。
 * 为什么写走 REST 而不直写 MySQL：联系人邮箱/电话在 EspoCRM 里是 junction 表
 * （entity_email_address 等），直写要复刻应用层不变量还会绕过其钩子与应用内审计；
 * REST 让 EspoCRM 自己维护这些。端点与字段映射基于公开 API 文档整理，
 * 未逐一实测——不确定项记录在 docs/espocrm-notes.md，改映射先改笔记。
 */
export interface EspoCrmRestOptions {
  /** 形如 https://crm.example.com，尾部斜杠会被剥掉 */
  baseUrl: string;
  apiKey: string;
  /** 测试注入用；缺省全局 fetch */
  fetchImpl?: typeof fetch;
}

const contactEntity = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  title: z.string().nullish(),
  accountId: z.string().nullish(),
  assignedUserId: z.string().nullish(),
  emailAddress: z.string().nullish(),
  phoneNumber: z.string().nullish(),
});

const opportunityEntity = z.object({
  id: z.string().min(1),
  name: z.string().nullish(),
  accountId: z.string().nullish(),
  stage: z.string().nullish(),
  amount: z.number().nullish(),
  amountCurrency: z.string().nullish(),
  probability: z.number().nullish(),
  closeDate: z.string().nullish(),
  assignedUserId: z.string().nullish(),
});

function toContactRow(entity: z.infer<typeof contactEntity>): ContactRow {
  return {
    contact_id: entity.id,
    name: entity.name ?? '',
    title: entity.title ?? '',
    account_id: entity.accountId ?? '',
    owner_id: entity.assignedUserId ?? '',
    email: entity.emailAddress ?? '',
    phone: entity.phoneNumber ?? '',
  };
}

function toOpportunityRow(entity: z.infer<typeof opportunityEntity>): OpportunityRow {
  return {
    opportunity_id: entity.id,
    name: entity.name ?? '',
    account_id: entity.accountId ?? '',
    stage: entity.stage ?? '',
    amount: entity.amount ?? 0,
    currency: entity.amountCurrency ?? '',
    probability: entity.probability ?? 0,
    close_date: entity.closeDate ?? '',
    owner_id: entity.assignedUserId ?? '',
  };
}

export class EspoCrmRestWriter {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: EspoCrmRestOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(method: string, path: string, body?: unknown): Promise<unknown | null> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/v1${path}`, {
      method,
      headers: {
        'X-Api-Key': this.options.apiKey,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      // EspoCRM 把失败原因放 X-Status-Reason 头；正文可能是 HTML，不透传
      const reason = res.headers.get('X-Status-Reason') ?? '';
      throw new Error(
        `espocrm REST ${method} ${path} 失败：HTTP ${res.status}${reason ? `（${reason}）` : ''}`,
      );
    }
    return (await res.json()) as unknown;
  }

  async createContact(input: CreateContactInput): Promise<ContactRow> {
    // 中文姓名整体入 lastName（EspoCRM name 是 first+last 拼接，整名入 last 显示不走样）
    const body = await this.request('POST', '/Contact', {
      lastName: input.name,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.account_id !== undefined ? { accountId: input.account_id } : {}),
      ...(input.email !== undefined ? { emailAddress: input.email } : {}),
      ...(input.phone !== undefined ? { phoneNumber: input.phone } : {}),
      assignedUserId: input.owner_id,
    });
    if (body === null) throw new Error('espocrm REST 创建联系人未返回实体');
    return toContactRow(contactEntity.parse(body));
  }

  async updateContact(contactId: string, patch: UpdateContactPatch): Promise<ContactRow | null> {
    const body = await this.request('PUT', `/Contact/${encodeURIComponent(contactId)}`, {
      ...(patch.name !== undefined ? { lastName: patch.name } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.email !== undefined ? { emailAddress: patch.email } : {}),
      ...(patch.phone !== undefined ? { phoneNumber: patch.phone } : {}),
    });
    if (body === null) return null;
    return toContactRow(contactEntity.parse(body));
  }

  async deleteContact(contactId: string): Promise<ContactRow | null> {
    // 先取后删：返回被删的行（守卫行级过滤要在返回值上看到 owner_id）
    const existing = await this.request('GET', `/Contact/${encodeURIComponent(contactId)}`);
    if (existing === null) return null;
    const row = toContactRow(contactEntity.parse(existing));
    await this.request('DELETE', `/Contact/${encodeURIComponent(contactId)}`);
    return row;
  }

  async updateOpportunityStage(
    opportunityId: string,
    stage: string,
  ): Promise<OpportunityRow | null> {
    const body = await this.request('PUT', `/Opportunity/${encodeURIComponent(opportunityId)}`, {
      stage,
    });
    if (body === null) return null;
    return toOpportunityRow(opportunityEntity.parse(body));
  }
}
