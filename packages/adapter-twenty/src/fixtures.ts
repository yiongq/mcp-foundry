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

const CURRENCY = 'CNY';

/**
 * 演示与评测数据——刻意与 adapter-espocrm 的 fixture 逐值相同：
 * 让「换 CRM 后端」成为真·透明替换，同一批题面、同一个演示在两个后端上行为一致。
 * 数值被评测题面引用，不要改动。身份沿用公司统一员工号命名空间。
 */
export const FIXTURE_OWNERS: Readonly<Record<string, string>> = {
  e005: '王五',
  e007: '孙七',
  e008: '周八',
};

export const FIXTURE_ACCOUNTS: readonly AccountDetail[] = [
  {
    account_id: 'a001',
    name: '华胜精密制造',
    industry: '制造业',
    owner_id: 'e007',
    website: 'www.huasheng.example.com',
    phone: '0512-88001001',
    city: '苏州',
  },
  {
    account_id: 'a002',
    name: '蓝川物流',
    industry: '物流',
    owner_id: 'e007',
    website: 'www.lanchuan.example.com',
    phone: '021-88002002',
    city: '上海',
  },
  {
    account_id: 'a003',
    name: '启明软件',
    industry: '软件',
    owner_id: 'e008',
    website: 'www.qiming.example.com',
    phone: '0571-88003003',
    city: '杭州',
  },
  {
    account_id: 'a004',
    name: '恒达商贸',
    industry: '零售',
    owner_id: 'e008',
    website: 'www.hengda.example.com',
    phone: '0755-88004004',
    city: '深圳',
  },
  {
    account_id: 'a005',
    name: '天工能源',
    industry: '能源',
    owner_id: 'e007',
    website: 'www.tiangong.example.com',
    phone: '010-88005005',
    city: '北京',
  },
];

export const FIXTURE_CONTACTS: readonly ContactRow[] = [
  {
    contact_id: 'c001',
    name: '陈建国',
    title: '采购总监',
    account_id: 'a001',
    owner_id: 'e007',
    email: 'chenjianguo@huasheng.example.com',
    phone: '13900001001',
  },
  {
    contact_id: 'c002',
    name: '刘敏',
    title: '运营经理',
    account_id: 'a002',
    owner_id: 'e007',
    email: 'liumin@lanchuan.example.com',
    phone: '13900001002',
  },
  {
    contact_id: 'c003',
    name: '周涛',
    title: '技术总监',
    account_id: 'a003',
    owner_id: 'e008',
    email: 'zhoutao@qiming.example.com',
    phone: '13900001003',
  },
  {
    contact_id: 'c004',
    name: '吴芳',
    title: '采购经理',
    account_id: 'a004',
    owner_id: 'e008',
    email: 'wufang@hengda.example.com',
    phone: '13900001004',
  },
  {
    contact_id: 'c005',
    name: '郑海',
    title: '设备部主任',
    account_id: 'a005',
    owner_id: 'e007',
    email: 'zhenghai@tiangong.example.com',
    phone: '13900001005',
  },
];

export const FIXTURE_OPPORTUNITIES: readonly OpportunityRow[] = [
  {
    opportunity_id: 'o001',
    name: '华胜产线扩建设备采购',
    account_id: 'a001',
    stage: 'Proposal',
    amount: 480000,
    currency: CURRENCY,
    probability: 60,
    close_date: '2026-09-30',
    owner_id: 'e007',
  },
  {
    opportunity_id: 'o002',
    name: '蓝川仓储管理系统年度合约',
    account_id: 'a002',
    stage: 'Negotiation',
    amount: 265000,
    currency: CURRENCY,
    probability: 75,
    close_date: '2026-08-15',
    owner_id: 'e007',
  },
  {
    opportunity_id: 'o003',
    name: '启明平台私有化部署',
    account_id: 'a003',
    stage: 'Closed Won',
    amount: 150000,
    currency: CURRENCY,
    probability: 100,
    close_date: '2026-06-30',
    owner_id: 'e008',
  },
  {
    opportunity_id: 'o004',
    name: '恒达门店POS升级',
    account_id: 'a004',
    stage: 'Prospecting',
    amount: 98000,
    currency: CURRENCY,
    probability: 20,
    close_date: '2026-10-31',
    owner_id: 'e008',
  },
  {
    opportunity_id: 'o005',
    name: '天工电站运维三年框架',
    account_id: 'a005',
    stage: 'Proposal',
    amount: 720000,
    currency: CURRENCY,
    probability: 55,
    close_date: '2026-11-30',
    owner_id: 'e007',
  },
];

/**
 * 实例态写：构造时深拷贝模块级常量，写入只动自己那份——模块级 FIXTURE_* 永不被改，
 * 每个测试/评测用例各建各的，互不串扰。与 adapter-espocrm 的 FixtureBackend 同款。
 */
export class FixtureBackend implements TwentyBackend {
  private readonly accounts: AccountDetail[] = FIXTURE_ACCOUNTS.map((a) => ({ ...a }));
  private readonly contacts: ContactRow[] = FIXTURE_CONTACTS.map((c) => ({ ...c }));
  private readonly opportunities: OpportunityRow[] = FIXTURE_OPPORTUNITIES.map((o) => ({ ...o }));
  private nextContactSeq = 100;

  async listAccounts(industry?: string): Promise<AccountRow[]> {
    const rows =
      industry === undefined ? this.accounts : this.accounts.filter((a) => a.industry === industry);
    return rows.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      industry: a.industry,
      owner_id: a.owner_id,
    }));
  }

  async getAccount(accountId: string): Promise<AccountDetail | null> {
    return this.accounts.find((a) => a.account_id === accountId) ?? null;
  }

  async listContacts(accountId?: string): Promise<ContactListRow[]> {
    const rows =
      accountId === undefined
        ? this.contacts
        : this.contacts.filter((c) => c.account_id === accountId);
    return rows.map((c) => ({
      contact_id: c.contact_id,
      name: c.name,
      title: c.title,
      account_id: c.account_id,
      owner_id: c.owner_id,
    }));
  }

  async getContact(contactId: string): Promise<ContactRow | null> {
    return this.contacts.find((c) => c.contact_id === contactId) ?? null;
  }

  async listOpportunities(stage?: string): Promise<OpportunityRow[]> {
    return stage === undefined
      ? [...this.opportunities]
      : this.opportunities.filter((o) => o.stage === stage);
  }

  async getOpportunity(opportunityId: string): Promise<OpportunityRow | null> {
    return this.opportunities.find((o) => o.opportunity_id === opportunityId) ?? null;
  }

  async createContact(input: CreateContactInput): Promise<ContactRow> {
    const row: ContactRow = {
      contact_id: `c${this.nextContactSeq++}`,
      name: input.name,
      title: input.title ?? '',
      account_id: input.account_id ?? '',
      owner_id: input.owner_id,
      email: input.email ?? '',
      phone: input.phone ?? '',
    };
    this.contacts.push(row);
    return row;
  }

  async updateContact(contactId: string, patch: UpdateContactPatch): Promise<ContactRow | null> {
    const row = this.contacts.find((c) => c.contact_id === contactId);
    if (!row) return null;
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.title !== undefined) row.title = patch.title;
    if (patch.email !== undefined) row.email = patch.email;
    if (patch.phone !== undefined) row.phone = patch.phone;
    return row;
  }

  async deleteContact(contactId: string): Promise<ContactRow | null> {
    const index = this.contacts.findIndex((c) => c.contact_id === contactId);
    if (index === -1) return null;
    const [removed] = this.contacts.splice(index, 1);
    return removed ?? null;
  }

  async updateOpportunityStage(
    opportunityId: string,
    stage: string,
  ): Promise<OpportunityRow | null> {
    const row = this.opportunities.find((o) => o.opportunity_id === opportunityId);
    if (!row) return null;
    row.stage = stage;
    return row;
  }

  async getPipelineSummary(): Promise<PipelineSummaryRow[]> {
    const byOwner = new Map<string, PipelineSummaryRow>();
    for (const o of this.opportunities) {
      const row = byOwner.get(o.owner_id) ?? {
        owner_id: o.owner_id,
        owner_name: FIXTURE_OWNERS[o.owner_id] ?? o.owner_id,
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
}
