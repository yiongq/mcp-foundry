// 后端一致性契约：FixtureBackend（本地/评测）与 TwentyRestBackend（线上真库）
// 必须给出相同的「安全 + 资金」行为——同一套断言两个实现都得过。
//
// 存在意义：本地手写 fixture 与真库 REST 是两套实现，会静默漂移（分页只读首页、
// 退款 404 被当成功、UUID vs c001 …都是漂移症状）。用同一份逻辑数据（FIXTURE_ORDERS
// 转成 Twenty REST 响应形状）喂给两个后端，任何行为分叉在这里当场亮红，而不是等上线才炸。
import { describe, expect, it } from 'vitest';
import type { RefundInput, TwentyBackend } from './backend.js';
import { FIXTURE_ORDERS, FixtureBackend } from './fixtures.js';
import { TwentyRestBackend } from './rest.js';

// 同一份逻辑数据：fixture 订单 → Twenty REST 的订单形状（name / lastFour / amountPaid / repCode）
const ORDER_ROWS = FIXTURE_ORDERS.map((o) => ({
  name: o.order_id,
  email: o.email,
  lastFour: o.last_four,
  amountPaid: o.amount_paid,
  repCode: o.owner_id,
}));

interface MockOpts {
  /** 订单分两页返回（首页 1 条 + 次页其余）——验分页聚合而非只读首页 */
  paginateOrders?: boolean;
  /** POST /refunds 的 HTTP 状态；404/204 用来验 fail-closed */
  refundHttpStatus?: number;
}

function mockTwentyFetch(opts: MockOpts = {}): typeof fetch {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const path = url.replace(/^.*\/rest/, '');

    if (method === 'POST' && path.startsWith('/refunds')) {
      const status = opts.refundHttpStatus ?? 200;
      if (status === 404 || status === 204) return new Response(null, { status });
      return json({ data: { createRefund: { id: 'rf-mock' } } });
    }
    if (method === 'GET' && path.startsWith('/orders')) {
      if (opts.paginateOrders) {
        return url.includes('starting_after')
          ? json({ data: { orders: ORDER_ROWS.slice(1) }, pageInfo: { hasNextPage: false } })
          : json({ data: { orders: ORDER_ROWS.slice(0, 1) }, pageInfo: { hasNextPage: true, endCursor: 'cur-1' } });
      }
      return json({ data: { orders: ORDER_ROWS } });
    }
    if (method === 'GET' && path.startsWith('/refunds')) {
      return json({ data: { refunds: [] } });
    }
    return json({ data: {} });
  }) as typeof fetch;
}

const restBackend = (opts?: MockOpts): TwentyRestBackend =>
  new TwentyRestBackend({
    baseUrl: 'https://crm.example.com',
    apiKey: 'k',
    ownerField: 'repCode',
    fetchImpl: mockTwentyFetch(opts),
  });

// ── 两个后端都必须满足的退款契约（安全 + 资金正确性）────────────────────────
function refundContract(label: string, makeBackend: () => TwentyBackend): void {
  const VALID: RefundInput = {
    order_id: 'ord-1001',
    email: 'chenjianguo@huasheng.example.com',
    last_four: '4321',
    amount: 200,
  };

  describe(`退款契约一致性 · ${label}`, () => {
    it('getOrder 命中：安全关键字段一致（order_id/email/last_four/amount_paid/owner_id）', async () => {
      expect(await makeBackend().getOrder('ord-1001')).toMatchObject({
        order_id: 'ord-1001',
        email: 'chenjianguo@huasheng.example.com',
        last_four: '4321',
        amount_paid: 480000,
        owner_id: 'e007',
        currency: 'CNY',
      });
    });

    it('getOrder 查无 → null', async () => {
      expect(await makeBackend().getOrder('ord-nope')).toBeNull();
    });

    it('issueRefund 合法 → issued，归属随订单（不取参数）', async () => {
      expect(await makeBackend().issueRefund(VALID)).toMatchObject({
        status: 'issued',
        amount: 200,
        owner_id: 'e007',
        order_id: 'ord-1001',
      });
    });

    it('issueRefund 卡尾号不符 → 抛错，不落账', async () => {
      await expect(makeBackend().issueRefund({ ...VALID, last_four: '0000' })).rejects.toThrow();
    });

    it('issueRefund 金额超过已付 → 抛错', async () => {
      await expect(makeBackend().issueRefund({ ...VALID, amount: 99_999_999 })).rejects.toThrow();
    });

    it('issueRefund 订单不存在 → 抛错（不静默成功）', async () => {
      await expect(
        makeBackend().issueRefund({ order_id: 'ord-nope', email: 'x@y.z', last_four: '0000', amount: 1 }),
      ).rejects.toThrow();
    });
  });
}

refundContract('fixture 本地后端', () => new FixtureBackend());
refundContract('twenty 真库 REST 后端', () => restBackend());

// ── 只针对 REST 的漂移护栏：fixture 天然满足、REST 曾漏、上线才暴露的坑 ────────
describe('REST 后端漂移护栏（fixture 掩盖不了这些）', () => {
  it('分页：落在第 2 页的订单也能被 getOrder 找到（不只读首页）', async () => {
    // ord-1002 在次页——只读首页会漏 → 曾导致 refundCountThisMonth 少算、绕过频次闸门
    expect((await restBackend({ paginateOrders: true }).getOrder('ord-1002'))?.order_id).toBe('ord-1002');
  });

  it('POST /refunds 返 404 → 抛错（fail-closed，绝不把没落库的退款报成 issued）', async () => {
    await expect(
      restBackend({ refundHttpStatus: 404 }).issueRefund({
        order_id: 'ord-1001',
        email: 'chenjianguo@huasheng.example.com',
        last_four: '4321',
        amount: 200,
      }),
    ).rejects.toThrow();
  });
});
