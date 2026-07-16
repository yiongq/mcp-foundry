import type {
  AccountDetail,
  AccountRow,
  ContactRow,
  EspoCrmBackend,
  OpportunityRow,
  PipelineSummaryRow,
} from './backend.js';

/**
 * 只读直连 MySQL 后端（EspoCRM 9.3 真实库表，见 docs/espocrm-db-schema.md）。
 *
 * 只读纪律（与 orangehrm 后端同款，层层兜底）：
 * 1. 连接账号是 SELECT-only 的专用用户（foundry_ro）——数据库侧强制，代码绕不过；
 * 2. 全部 SQL 是静态字符串 + 参数占位，没有任何拼接——注入面在结构上不存在；
 * 3. 每条查询显式 LIMIT。
 *
 * 精确匹配纪律：id / industry / stage 比较一律走 CAST(... AS BINARY) 字节比较——
 * EspoCRM 的列是 utf8mb4_unicode_ci（大小写不敏感；表级 DEFAULT 才是 utf8mb3，
 * 9.3.10 实测），不加 BINARY 则「O001 变造命中 o001 行」，与 fixture 的精确匹配
 * 语义不同构（评测 cr11 题）。
 *
 * 实体映射（实测结论）：电话/邮箱不在主表，走 entity_phone_number /
 * entity_email_address 关联（只取 primary=1）；联系人职务在 account_contact.role；
 * assigned_user_id 归一为统一行结构的 owner_id。
 */
export interface MySqlBackendOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  /** 测试注入用：替换真实连接池 */
  executor?: SqlExecutor;
}

export interface SqlExecutor {
  query(sql: string, params: ReadonlyArray<string>): Promise<Array<Record<string, unknown>>>;
  end(): Promise<void>;
}

/** 姓名拼接：中文整名存 last_name、first_name 留空（种子数据约定，姓在前），西式拆分名同样兼容。 */
const CONTACT_NAME_EXPR = "TRIM(CONCAT(COALESCE(c.last_name, ''), COALESCE(c.first_name, '')))";
const USER_NAME_EXPR = "TRIM(CONCAT(COALESCE(u.last_name, ''), COALESCE(u.first_name, '')))";

const LIST_ACCOUNTS_SQL = `
SELECT a.id AS account_id, a.name, COALESCE(a.industry, '') AS industry,
       COALESCE(a.assigned_user_id, '') AS owner_id
FROM account a
WHERE a.deleted = 0`;

const LIST_ACCOUNTS_INDUSTRY_FILTER = ' AND CAST(a.industry AS BINARY) = CAST(? AS BINARY)';
const LIST_ACCOUNTS_ORDER = ' ORDER BY a.id LIMIT 500';

const ACCOUNT_DETAIL_SQL = `
SELECT a.id AS account_id, a.name, COALESCE(a.industry, '') AS industry,
       COALESCE(a.assigned_user_id, '') AS owner_id,
       COALESCE(a.website, '') AS website,
       COALESCE(pn.name, '') AS phone,
       COALESCE(a.billing_address_city, '') AS city
FROM account a
LEFT JOIN entity_phone_number epn
  ON epn.entity_id = a.id AND epn.entity_type = 'Account'
 AND epn.deleted = 0 AND epn.\`primary\` = 1
LEFT JOIN phone_number pn ON pn.id = epn.phone_number_id AND pn.deleted = 0
WHERE a.deleted = 0 AND CAST(a.id AS BINARY) = CAST(? AS BINARY)
LIMIT 1`;

const CONTACT_SQL = `
SELECT c.id AS contact_id, ${CONTACT_NAME_EXPR} AS name,
       COALESCE(ac.role, '') AS title,
       COALESCE(c.account_id, '') AS account_id,
       COALESCE(c.assigned_user_id, '') AS owner_id,
       COALESCE(ea.name, '') AS email,
       COALESCE(pn.name, '') AS phone
FROM contact c
LEFT JOIN account_contact ac
  ON ac.contact_id = c.id AND ac.account_id = c.account_id AND ac.deleted = 0
LEFT JOIN entity_email_address eea
  ON eea.entity_id = c.id AND eea.entity_type = 'Contact'
 AND eea.deleted = 0 AND eea.\`primary\` = 1
LEFT JOIN email_address ea ON ea.id = eea.email_address_id AND ea.deleted = 0
LEFT JOIN entity_phone_number epn
  ON epn.entity_id = c.id AND epn.entity_type = 'Contact'
 AND epn.deleted = 0 AND epn.\`primary\` = 1
LEFT JOIN phone_number pn ON pn.id = epn.phone_number_id AND pn.deleted = 0
WHERE c.deleted = 0 AND CAST(c.id AS BINARY) = CAST(? AS BINARY)
LIMIT 1`;

const OPPORTUNITY_SELECT = `
SELECT o.id AS opportunity_id, o.name, COALESCE(o.account_id, '') AS account_id,
       COALESCE(o.stage, '') AS stage, o.amount,
       COALESCE(o.amount_currency, '') AS currency, o.probability,
       COALESCE(DATE_FORMAT(o.close_date, '%Y-%m-%d'), '') AS close_date,
       COALESCE(o.assigned_user_id, '') AS owner_id
FROM opportunity o
WHERE o.deleted = 0`;

const LIST_OPPORTUNITIES_STAGE_FILTER = ' AND CAST(o.stage AS BINARY) = CAST(? AS BINARY)';
const LIST_OPPORTUNITIES_ORDER = ' ORDER BY o.id LIMIT 500';
const OPPORTUNITY_BY_ID = ' AND CAST(o.id AS BINARY) = CAST(? AS BINARY) LIMIT 1';

/**
 * 与 fixture 后端同一口径：Closed Won 计入赢单，Closed Lost 不计，其余都是在途。
 * stage 先 COALESCE 成 ''：真库 stage 列可空（API 导入/直插都能造出 NULL），
 * 裸 NULL NOT IN (...) 是 NULL 会被 SUM 静默跳过——该行在 list_opportunities 里
 * 显示为 stage ''（在途），却从汇总里消失，同一后端的明细与汇总对不上账。
 */
const PIPELINE_SQL = `
SELECT o.assigned_user_id AS owner_id, ${USER_NAME_EXPR} AS owner_name,
       SUM(COALESCE(o.stage, '') NOT IN ('Closed Won', 'Closed Lost')) AS open_count,
       COALESCE(SUM(CASE WHEN COALESCE(o.stage, '') NOT IN ('Closed Won', 'Closed Lost') THEN o.amount ELSE 0 END), 0) AS open_amount,
       SUM(COALESCE(o.stage, '') = 'Closed Won') AS won_count,
       COALESCE(SUM(CASE WHEN COALESCE(o.stage, '') = 'Closed Won' THEN o.amount ELSE 0 END), 0) AS won_amount
FROM opportunity o
LEFT JOIN \`user\` u ON u.id = o.assigned_user_id AND u.deleted = 0
WHERE o.deleted = 0 AND o.assigned_user_id IS NOT NULL
GROUP BY o.assigned_user_id, u.last_name, u.first_name
ORDER BY owner_id
LIMIT 500`;

export class MySqlEspoCrmBackend implements EspoCrmBackend {
  private executor: SqlExecutor | null;

  constructor(private readonly options: MySqlBackendOptions) {
    this.executor = options.executor ?? null;
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

  async listAccounts(industry?: string): Promise<AccountRow[]> {
    const executor = await this.getExecutor();
    const sql =
      industry === undefined
        ? `${LIST_ACCOUNTS_SQL}${LIST_ACCOUNTS_ORDER}`
        : `${LIST_ACCOUNTS_SQL}${LIST_ACCOUNTS_INDUSTRY_FILTER}${LIST_ACCOUNTS_ORDER}`;
    const rows = await executor.query(sql, industry === undefined ? [] : [industry]);
    return rows.map((row) => ({
      account_id: String(row.account_id),
      name: String(row.name),
      industry: String(row.industry),
      owner_id: String(row.owner_id),
    }));
  }

  async getAccount(accountId: string): Promise<AccountDetail | null> {
    const executor = await this.getExecutor();
    const rows = await executor.query(ACCOUNT_DETAIL_SQL, [accountId]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      account_id: String(row.account_id),
      name: String(row.name),
      industry: String(row.industry),
      owner_id: String(row.owner_id),
      website: String(row.website),
      phone: String(row.phone),
      city: String(row.city),
    };
  }

  async getContact(contactId: string): Promise<ContactRow | null> {
    const executor = await this.getExecutor();
    const rows = await executor.query(CONTACT_SQL, [contactId]);
    const row = rows[0];
    if (row === undefined) return null;
    return {
      contact_id: String(row.contact_id),
      name: String(row.name),
      title: String(row.title),
      account_id: String(row.account_id),
      owner_id: String(row.owner_id),
      email: String(row.email),
      phone: String(row.phone),
    };
  }

  async listOpportunities(stage?: string): Promise<OpportunityRow[]> {
    const executor = await this.getExecutor();
    const sql =
      stage === undefined
        ? `${OPPORTUNITY_SELECT}${LIST_OPPORTUNITIES_ORDER}`
        : `${OPPORTUNITY_SELECT}${LIST_OPPORTUNITIES_STAGE_FILTER}${LIST_OPPORTUNITIES_ORDER}`;
    const rows = await executor.query(sql, stage === undefined ? [] : [stage]);
    return rows.map((row) => toOpportunityRow(row));
  }

  async getOpportunity(opportunityId: string): Promise<OpportunityRow | null> {
    const executor = await this.getExecutor();
    const rows = await executor.query(`${OPPORTUNITY_SELECT}${OPPORTUNITY_BY_ID}`, [opportunityId]);
    const row = rows[0];
    if (row === undefined) return null;
    return toOpportunityRow(row);
  }

  async getPipelineSummary(): Promise<PipelineSummaryRow[]> {
    const executor = await this.getExecutor();
    const rows = await executor.query(PIPELINE_SQL, []);
    return rows.map((row) => ({
      owner_id: String(row.owner_id),
      // 归属人不在 user 表时退回 id 展示——与 fixture 后端同款兜底
      owner_name: String(row.owner_name ?? '') || String(row.owner_id),
      // SUM/COUNT 经 mysql2 可能回 DECIMAL 字符串；非数字宁可 NaN 显形，不静默造数
      open_count: Number(row.open_count),
      open_amount: Number(row.open_amount),
      won_count: Number(row.won_count),
      won_amount: Number(row.won_amount),
    }));
  }
}

function toOpportunityRow(row: Record<string, unknown>): OpportunityRow {
  return {
    opportunity_id: String(row.opportunity_id),
    name: String(row.name),
    account_id: String(row.account_id),
    stage: String(row.stage),
    amount: Number(row.amount),
    currency: String(row.currency),
    probability: Number(row.probability),
    close_date: String(row.close_date),
    owner_id: String(row.owner_id),
  };
}
