import { describe, expect, it } from 'vitest';
import { MySqlEspoCrmBackend, type SqlExecutor } from './mysql.js';

interface Captured {
  sql: string;
  params: ReadonlyArray<string>;
}

function fakeExecutor(rows: Array<Record<string, unknown>>): {
  executor: SqlExecutor;
  captured: Captured[];
} {
  const captured: Captured[] = [];
  return {
    captured,
    executor: {
      query: async (sql, params) => {
        captured.push({ sql, params });
        return rows;
      },
      end: async () => {},
    },
  };
}

const OPTS = { host: 'x', port: 3308, database: 'espocrm', user: 'ro', password: 'pw' };

describe('MySqlEspoCrmBackend', () => {
  it('listAccounts：无过滤不带 industry 条件；有过滤走参数占位，永不拼接', async () => {
    const { executor, captured } = fakeExecutor([
      { account_id: 'a001', name: '华胜精密制造', industry: '制造业', owner_id: 'e007' },
    ]);
    const backend = new MySqlEspoCrmBackend({ ...OPTS, executor });

    const all = await backend.listAccounts();
    expect(all).toEqual([
      { account_id: 'a001', name: '华胜精密制造', industry: '制造业', owner_id: 'e007' },
    ]);
    expect(captured[0]?.sql).not.toContain('industry AS BINARY');
    expect(captured[0]?.params).toEqual([]);

    await backend.listAccounts('制造业');
    // 精确匹配纪律：字节比较，不吃大小写不敏感 collation
    expect(captured[1]?.sql).toContain('CAST(a.industry AS BINARY) = CAST(? AS BINARY)');
    expect(captured[1]?.params).toEqual(['制造业']);
    // 只读纪律：静态 SQL + LIMIT，过滤值绝不出现在 SQL 文本里
    expect(captured[1]?.sql).toContain('LIMIT');
    expect(captured[1]?.sql).not.toContain('制造业');
  });

  it('getAccount：软删过滤 + phone 走 primary 关联 + 查无此户返回 null', async () => {
    const { executor, captured } = fakeExecutor([]);
    const backend = new MySqlEspoCrmBackend({ ...OPTS, executor });

    expect(await backend.getAccount('a999')).toBeNull();
    expect(captured[0]?.sql).toContain('a.deleted = 0');
    expect(captured[0]?.sql).toContain("epn.entity_type = 'Account'");
    expect(captured[0]?.sql).toContain('epn.`primary` = 1');
    expect(captured[0]?.sql).toContain('CAST(a.id AS BINARY)');
    expect(captured[0]?.params).toEqual(['a999']);
  });

  it('listContacts：列表最小化不 join 联系方式表；account_id 过滤字节比较', async () => {
    const { executor, captured } = fakeExecutor([
      {
        contact_id: 'c001',
        name: '陈建国',
        title: '采购总监',
        account_id: 'a001',
        owner_id: 'e007',
      },
    ]);
    const backend = new MySqlEspoCrmBackend({ ...OPTS, executor });

    const rows = await backend.listContacts('a001');
    expect(rows[0]).toEqual({
      contact_id: 'c001',
      name: '陈建国',
      title: '采购总监',
      account_id: 'a001',
      owner_id: 'e007',
    });
    // 数据面最小化：列表 SQL 不得触碰电话/邮箱关联表
    expect(captured[0]?.sql).not.toContain('entity_phone_number');
    expect(captured[0]?.sql).not.toContain('entity_email_address');
    expect(captured[0]?.sql).toContain('CAST(c.account_id AS BINARY) = CAST(? AS BINARY)');
    expect(captured[0]?.sql).toContain('LIMIT');
    expect(captured[0]?.params).toEqual(['a001']);

    await backend.listContacts();
    expect(captured[1]?.sql).not.toContain('c.account_id AS BINARY');
    expect(captured[1]?.params).toEqual([]);
  });

  it('getContact：姓名拼接、职务取 account_contact.role、邮箱/电话走关联表', async () => {
    const { executor, captured } = fakeExecutor([
      {
        contact_id: 'c001',
        name: '陈建国',
        title: '采购总监',
        account_id: 'a001',
        owner_id: 'e007',
        email: 'chenjianguo@huasheng.example.com',
        phone: '13900001001',
      },
    ]);
    const backend = new MySqlEspoCrmBackend({ ...OPTS, executor });

    expect(await backend.getContact('c001')).toEqual({
      contact_id: 'c001',
      name: '陈建国',
      title: '采购总监',
      account_id: 'a001',
      owner_id: 'e007',
      email: 'chenjianguo@huasheng.example.com',
      phone: '13900001001',
    });
    expect(captured[0]?.sql).toContain('account_contact');
    expect(captured[0]?.sql).toContain('entity_email_address');
    expect(captured[0]?.params).toEqual(['c001']);
  });

  it('listOpportunities：stage 过滤字节比较；double/int/date 归一为统一行结构', async () => {
    const { executor, captured } = fakeExecutor([
      {
        opportunity_id: 'o001',
        name: '华胜产线扩建设备采购',
        account_id: 'a001',
        stage: 'Proposal',
        amount: 480000,
        currency: 'CNY',
        probability: 60,
        close_date: '2026-09-30',
        owner_id: 'e007',
      },
    ]);
    const backend = new MySqlEspoCrmBackend({ ...OPTS, executor });

    const rows = await backend.listOpportunities('Proposal');
    expect(rows[0]).toEqual({
      opportunity_id: 'o001',
      name: '华胜产线扩建设备采购',
      account_id: 'a001',
      stage: 'Proposal',
      amount: 480000,
      currency: 'CNY',
      probability: 60,
      close_date: '2026-09-30',
      owner_id: 'e007',
    });
    expect(captured[0]?.sql).toContain('CAST(o.stage AS BINARY) = CAST(? AS BINARY)');
    expect(captured[0]?.sql).toContain("DATE_FORMAT(o.close_date, '%Y-%m-%d')");
    expect(captured[0]?.params).toEqual(['Proposal']);
  });

  it('getOpportunity：按 id 字节比较 + LIMIT 1；查无此单返回 null', async () => {
    const { executor, captured } = fakeExecutor([]);
    const backend = new MySqlEspoCrmBackend({ ...OPTS, executor });

    expect(await backend.getOpportunity('O001')).toBeNull();
    // cr11 变造题依赖的纪律：大小写不敏感 collation 下必须字节精确匹配
    expect(captured[0]?.sql).toContain('CAST(o.id AS BINARY) = CAST(? AS BINARY)');
    expect(captured[0]?.sql).toContain('LIMIT 1');
    expect(captured[0]?.sql).toContain('o.deleted = 0');
    expect(captured[0]?.params).toEqual(['O001']);
  });

  it('getPipelineSummary：SUM 回 DECIMAL 字符串照样转数值；无名归属人退回 id', async () => {
    const { executor, captured } = fakeExecutor([
      {
        owner_id: 'e007',
        owner_name: '孙七',
        open_count: '3',
        open_amount: '1465000',
        won_count: '0',
        won_amount: '0',
      },
      {
        owner_id: 'e999',
        owner_name: '',
        open_count: '1',
        open_amount: '5000',
        won_count: '0',
        won_amount: '0',
      },
    ]);
    const backend = new MySqlEspoCrmBackend({ ...OPTS, executor });

    const rows = await backend.getPipelineSummary();
    expect(rows[0]).toEqual({
      owner_id: 'e007',
      owner_name: '孙七',
      open_count: 3,
      open_amount: 1465000,
      won_count: 0,
      won_amount: 0,
    });
    expect(rows[1]?.owner_name).toBe('e999');
    // 赢单/在途口径与 fixture 后端一致，且软删与无归属行不进汇总
    expect(captured[0]?.sql).toContain("'Closed Won'");
    expect(captured[0]?.sql).toContain('o.assigned_user_id IS NOT NULL');
    // 真库 stage 可空：裸 NULL NOT IN 会被 SUM 静默跳过，明细与汇总对不上账
    expect(captured[0]?.sql).toContain("COALESCE(o.stage, '')");
    expect(captured[0]?.params).toEqual([]);
  });

  it('注入 executor 时 end 只收口注入的实现，不碰真实网络', async () => {
    let ended = false;
    const backend = new MySqlEspoCrmBackend({
      ...OPTS,
      executor: {
        query: async () => [],
        end: async () => {
          ended = true;
        },
      },
    });
    await backend.end();
    expect(ended).toBe(true);
  });
});
