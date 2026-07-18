/**
 * Twenty CRM 适配器的统一行结构——固定为 account/contact/opportunity 三类 + owner_id 归属戳，字段名 snake_case，
 * 与 RBAC 行规则里的 field（owner_id）逐字对齐、与守卫/评测解耦。
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
 * 订单（退款的身份核验锚点）：退款必须提供 order_id + 客户邮箱 + 卡尾号，与订单记录逐项对上
 * 才可能落到退款 API——「身份核验前置于资金动作」。owner_id 使退款也受行级归属约束
 * （只退自己名下订单）。演示口径：真实 Twenty 无订单/退款对象，仅 fixture 后端提供。
 */
export interface OrderRow {
  order_id: string;
  account_id: string;
  email: string;
  last_four: string;
  amount_paid: number;
  currency: string;
  owner_id: string;
}

export interface RefundInput {
  order_id: string;
  email: string;
  last_four: string;
  amount: number;
  reason?: string | undefined;
}

export interface RefundResult {
  refund_id: string;
  order_id: string;
  account_id: string;
  amount: number;
  currency: string;
  status: 'issued';
  owner_id: string;
}

/**
 * 数据来源抽象：fixture（内置演示数据）与 Twenty REST 各实现一份。
 * 写方法约定：目标不存在返回 null；update/delete 返回受影响的完整行
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
  /** 退款目标订单（守卫据此做行级归属前置校验；不存在返回 null） */
  getOrder(orderId: string): Promise<OrderRow | null>;
  /** 退款：身份核验（邮箱+卡尾号对上订单）+ 金额不超已付 + 记账计数。核验不过即抛。 */
  issueRefund(input: RefundInput): Promise<RefundResult>;
  /** 分级信号：某人本周期已成功退款笔数（供审批闸门按频次分档）。 */
  refundCountThisMonth(ownerId: string): Promise<number>;
}
