/**
 * 六个工具的统一行结构（fixture 与只读 MySQL 两个后端都必须映射到这套形状）。
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

export interface ContactRow {
  contact_id: string;
  name: string;
  title: string;
  account_id: string;
  owner_id: string;
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

/** 数据来源抽象：fixture（内置演示数据）与只读 MySQL（真实 EspoCRM）各实现一份。 */
export interface EspoCrmBackend {
  listAccounts(industry?: string): Promise<AccountRow[]>;
  getAccount(accountId: string): Promise<AccountDetail | null>;
  getContact(contactId: string): Promise<ContactRow | null>;
  listOpportunities(stage?: string): Promise<OpportunityRow[]>;
  getOpportunity(opportunityId: string): Promise<OpportunityRow | null>;
  getPipelineSummary(): Promise<PipelineSummaryRow[]>;
}
