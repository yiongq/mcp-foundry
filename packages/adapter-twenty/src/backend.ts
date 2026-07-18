/**
 * Twenty CRM 适配器的统一行结构——刻意与 adapter-espocrm 逐字段同名
 * （account/contact/opportunity，owner_id 归属戳），使得同一套守卫规则、同一套工具、
 * 同一批评测题面在两个后端上通用：换 CRM 后端对上层完全透明。
 * Twenty 侧的真实字段（firstName/lastName、jobTitle、company 关系、emails 数组）
 * 在 REST 后端里翻译成这套形状，映射见 src/rest.ts 与 docs/twenty-notes.md。
 */
export interface AccountRow {
  account_id: string;
  name: string;
  industry: string;
  owner_id: string;
}

export interface AccountDetail extends AccountRow {
  website: string;
  phone: string;
  city: string;
}

export interface ContactListRow {
  contact_id: string;
  name: string;
  title: string;
  account_id: string;
  owner_id: string;
}

export interface ContactRow extends ContactListRow {
  email: string;
  phone: string;
}

export interface OpportunityRow {
  opportunity_id: string;
  name: string;
  account_id: string;
  stage: string;
  amount: number;
  currency: string;
  probability: number;
  close_date: string;
  owner_id: string;
}

export interface PipelineSummaryRow {
  owner_id: string;
  owner_name: string;
  open_count: number;
  open_amount: number;
  won_count: number;
  won_amount: number;
}

export interface CreateContactInput {
  name: string;
  title?: string | undefined;
  account_id?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
  owner_id: string;
}

export interface UpdateContactPatch {
  name?: string | undefined;
  title?: string | undefined;
  email?: string | undefined;
  phone?: string | undefined;
}

/**
 * 数据来源抽象：fixture（内置演示数据）与 Twenty REST 各实现一份。
 * 写方法约定同 espocrm：目标不存在返回 null；update/delete 返回受影响的完整行
 * （必须含 owner_id——守卫行级过滤在返回值上跑，缺归属字段会被误拒）。
 */
export interface TwentyBackend {
  listAccounts(industry?: string): Promise<AccountRow[]>;
  getAccount(accountId: string): Promise<AccountDetail | null>;
  listContacts(accountId?: string): Promise<ContactListRow[]>;
  getContact(contactId: string): Promise<ContactRow | null>;
  listOpportunities(stage?: string): Promise<OpportunityRow[]>;
  getOpportunity(opportunityId: string): Promise<OpportunityRow | null>;
  getPipelineSummary(): Promise<PipelineSummaryRow[]>;
  createContact(input: CreateContactInput): Promise<ContactRow>;
  updateContact(contactId: string, patch: UpdateContactPatch): Promise<ContactRow | null>;
  deleteContact(contactId: string): Promise<ContactRow | null>;
  updateOpportunityStage(opportunityId: string, stage: string): Promise<OpportunityRow | null>;
}
