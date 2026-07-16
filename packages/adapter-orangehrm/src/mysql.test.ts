import { describe, expect, it } from 'vitest';
import { MySqlOrangeHrmBackend, type SqlExecutor } from './mysql.js';

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

const OPTS = { host: 'x', port: 3307, database: 'orangehrm', user: 'ro', password: 'pw' };

describe('MySqlOrangeHrmBackend', () => {
  it('listEmployees：无过滤不带 dept 条件；有过滤走参数占位，永不拼接', async () => {
    const { executor, captured } = fakeExecutor([
      { employee_id: 'e001', name: '张三', dept: '生产部', title: '设备工程师' },
    ]);
    const backend = new MySqlOrangeHrmBackend({ ...OPTS, executor });

    const all = await backend.listEmployees();
    expect(all).toEqual([
      { employee_id: 'e001', name: '张三', dept: '生产部', title: '设备工程师' },
    ]);
    expect(captured[0]?.sql).not.toContain('s.name = ?');
    expect(captured[0]?.params).toEqual([]);

    await backend.listEmployees('生产部');
    // 精确匹配纪律：字节比较，不吃大小写不敏感 collation
    expect(captured[1]?.sql).toContain('CAST(s.name AS BINARY) = CAST(? AS BINARY)');
    expect(captured[1]?.params).toEqual(['生产部']);
    // 只读纪律：静态 SQL + LIMIT，过滤值绝不出现在 SQL 文本里
    expect(captured[1]?.sql).toContain('LIMIT');
    expect(captured[1]?.sql).not.toContain('生产部');
  });

  it('getEmployee：termination 过滤 + 查无此人返回 null', async () => {
    const { executor, captured } = fakeExecutor([]);
    const backend = new MySqlOrangeHrmBackend({ ...OPTS, executor });

    expect(await backend.getEmployee('e999')).toBeNull();
    expect(captured[0]?.sql).toContain('termination_id IS NULL');
    expect(captured[0]?.sql).toContain('CAST(e.employee_id AS BINARY)');
    expect(captured[0]?.params).toEqual(['e999']);
  });

  it('getSalary：varchar 金额转数值，effective_date 为空串（源表无此列）', async () => {
    const { executor } = fakeExecutor([
      { employee_id: 'e001', name: '张三', salary: '18500', currency: 'CNY' },
    ]);
    const backend = new MySqlOrangeHrmBackend({ ...OPTS, executor });

    expect(await backend.getSalary('e001')).toEqual({
      employee_id: 'e001',
      name: '张三',
      salary: 18500,
      currency: 'CNY',
      effective_date: '',
    });
  });

  it('getLeaveBalance：decimal 字符串转数值并计算 annual_left；leave_type 名走参数', async () => {
    const { executor, captured } = fakeExecutor([
      {
        employee_id: 'e001',
        name: '张三',
        annual_total: '10.000000000000000',
        annual_used: '6.0000',
      },
    ]);
    const backend = new MySqlOrangeHrmBackend({ ...OPTS, executor });

    expect(await backend.getLeaveBalance('e001')).toEqual({
      employee_id: 'e001',
      name: '张三',
      annual_total: 10,
      annual_used: 6,
      annual_left: 4,
    });
    expect(captured[0]?.params).toEqual(['年假', 'e001']);
  });

  it('注入 executor 时 end 只收口注入的实现，不碰真实网络', async () => {
    let ended = false;
    const backend = new MySqlOrangeHrmBackend({
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
