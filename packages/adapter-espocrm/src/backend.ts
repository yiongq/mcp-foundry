/**
 * 七个工具的统一行结构（fixture 与只读 MySQL 两个后端都必须映射到这套形状）。
 * 字段名刻意用 snake_case——与 RBAC 行规则里的 field（owner_id）逐字对齐。
 * 实体与字段按 EspoCRM 建模（Account / Contact / Opportunity，
 * assigned_user_id 归一为 owner_id），映射已对真实 EspoCRM 9.3 实测验证，
 * 依据见 docs/espocrm-db-schema.md。
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

/** 联系人列表行：数据面最小化，不带联系方式——email/phone 只在 get_contact 详情里 */
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

/** 写入类工具的入参形状（owner_id 由适配器从 principal 盖戳，不来自工具参数） */
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
 * 数据来源抽象：fixture（内置演示数据）与只读 MySQL（真实 EspoCRM）各实现一份。
 * 写方法的约定：目标不存在返回 null；update/delete 返回受影响的完整行
 * （必须含 owner_id——守卫的行级过滤在返回值上跑，缺了归属字段会被误拒）。
 * MySQL 后端对写方法一律抛错（foundry_ro 账号仅 SELECT，三层只读纪律不破）；
 * 真实写入走 EspoCRM REST（withRestWrites 组合）。
 */
export interface EspoCrmBackend {
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
