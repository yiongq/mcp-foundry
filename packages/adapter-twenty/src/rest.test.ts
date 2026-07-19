import { describe, expect, it } from 'vitest';
import { TwentyRestBackend } from './rest.js';

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(responses: Array<{ status?: number; json?: unknown }>): {
  fetchImpl: typeof fetch;
  requests: Captured[];
} {
  const requests: Captured[] = [];
  let i = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const spec = responses[Math.min(i++, responses.length - 1)] ?? {};
    const status = spec.status ?? 200;
    const noBody = status === 404 || status === 204;
    return new Response(noBody ? null : JSON.stringify(spec.json ?? {}), { status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

// Twenty person 实体形状：复合 name / emails / phones + jobTitle + companyId + 自定义 ownerId
const PERSON = {
  id: 'p-1',
  name: { firstName: '', lastName: '陈建国' },
  jobTitle: '采购总监',
  companyId: 'co-1',
  emails: { primaryEmail: 'chen@huasheng.example.com' },
  phones: { primaryPhoneNumber: '13900001001' },
  ownerId: 'e007',
};

function backend(fetchImpl: typeof fetch) {
  return new TwentyRestBackend({ baseUrl: 'https://crm.example.com/', apiKey: 'k1', fetchImpl });
}

describe('TwentyRestBackend 字段映射', () => {
  it('getContact：复合 name/emails/phones → 统一行结构；Bearer 头；/rest 前缀', async () => {
    const { fetchImpl, requests } = makeFetch([{ json: { data: { person: PERSON } } }]);
    const row = await backend(fetchImpl).getContact('p-1');

    expect(requests[0]?.url).toBe('https://crm.example.com/rest/people/p-1');
    expect(requests[0]?.headers.authorization).toBe('Bearer k1');
    expect(row).toEqual({
      contact_id: 'p-1',
      name: '陈建国',
      title: '采购总监',
      account_id: 'co-1',
      owner_id: 'e007',
      email: 'chen@huasheng.example.com',
      phone: '13900001001',
    });
  });

  it('listContacts：解开 {data:{people:[…]}} 列表包封', async () => {
    const { fetchImpl } = makeFetch([
      { json: { data: { people: [PERSON, { ...PERSON, id: 'p-2' }] } } },
    ]);
    const rows = await backend(fetchImpl).listContacts();
    expect(rows.map((r) => r.contact_id)).toEqual(['p-1', 'p-2']);
    // 列表行不带联系方式
    expect(rows[0]).not.toHaveProperty('email');
  });

  it('createContact：POST 返回包在操作名键 createPerson 下，仍正确映射回行', async () => {
    // Twenty 的写响应包在操作名键（createPerson/updatePerson），不是 GET 的 person
    const { fetchImpl, requests } = makeFetch([{ json: { data: { createPerson: PERSON } } }]);
    const row = await backend(fetchImpl).createContact({
      name: '陈建国',
      title: '采购总监',
      email: 'x@y.com',
      owner_id: 'e007',
    });
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.url).toBe('https://crm.example.com/rest/people');
    expect(requests[0]?.body).toEqual({
      name: { firstName: '', lastName: '陈建国' },
      jobTitle: '采购总监',
      emails: { primaryEmail: 'x@y.com' },
      ownerId: 'e007',
    });
    expect(row.contact_id).toBe('p-1'); // 返回行被正确解出（不是抛 ZodError）
  });

  it('updateContact：PATCH 返回包在 updatePerson 下也能解出；404 → null', async () => {
    const { fetchImpl, requests } = makeFetch([{ json: { data: { updatePerson: PERSON } } }]);
    const row = await backend(fetchImpl).updateContact('p-1', { title: '副总裁' });
    expect(requests[0]?.method).toBe('PATCH');
    expect(requests[0]?.body).toEqual({ jobTitle: '副总裁' });
    expect(row?.contact_id).toBe('p-1');

    const { fetchImpl: f404 } = makeFetch([{ status: 404 }]);
    expect(await backend(f404).updateContact('nope', { title: 'x' })).toBeNull();
  });

  it('deleteContact：先 GET 取行再 DELETE，返回被删行；GET 404 不发 DELETE', async () => {
    const { fetchImpl, requests } = makeFetch([
      { json: { data: { person: PERSON } } },
      { status: 204 },
    ]);
    const row = await backend(fetchImpl).deleteContact('p-1');
    expect(requests.map((r) => r.method)).toEqual(['GET', 'DELETE']);
    expect(row?.contact_id).toBe('p-1');

    const { fetchImpl: f404, requests: miss } = makeFetch([{ status: 404 }]);
    expect(await backend(f404).deleteContact('nope')).toBeNull();
    expect(miss).toHaveLength(1);
  });

  it('opportunity：amountMicros 是字符串（BigInt 序列化）也能换算回元；updateStage 包在 updateOpportunity 下', async () => {
    const opp = {
      id: 'op-1',
      name: '大单',
      companyId: 'co-1',
      stage: 'Proposal',
      // Twenty 真实形状：amountMicros 是字符串
      amount: { amountMicros: '480000000000', currencyCode: 'CNY' },
      closeDate: '2026-09-30T00:00:00.000Z',
      ownerId: 'e007',
    };
    const { fetchImpl } = makeFetch([{ json: { data: { opportunity: opp } } }]);
    const o = await backend(fetchImpl).getOpportunity('op-1');
    expect(o?.amount).toBe(480000);
    expect(o?.close_date).toBe('2026-09-30');
    expect(o?.owner_id).toBe('e007');

    // 改阶段的写响应包在 updateOpportunity 键下
    const { fetchImpl: f2 } = makeFetch([
      { json: { data: { updateOpportunity: { ...opp, stage: 'Closed Won' } } } },
    ]);
    const updated = await backend(f2).updateOpportunityStage('op-1', 'Closed Won');
    expect(updated?.stage).toBe('Closed Won');
  });

  it('getPipelineSummary：owner_name 用演示名表映射(e007→林哲)；Twenty 枚举经 stage 映射后 won/open 正确分桶', async () => {
    const { fetchImpl } = makeFetch([
      {
        json: {
          data: {
            opportunities: [
              { id: 'o1', name: 'A', stage: 'PROPOSAL', amount: { amountMicros: '480000000000' }, ownerId: 'e007' },
              { id: 'o2', name: 'B', stage: 'CUSTOMER', amount: { amountMicros: '150000000000' }, ownerId: 'e008' },
            ],
          },
        },
      },
    ]);
    const rows = await backend(fetchImpl).getPipelineSummary();
    const e007 = rows.find((r) => r.owner_id === 'e007');
    const e008 = rows.find((r) => r.owner_id === 'e008');
    expect(e007?.owner_name).toBe('林哲'); // 不再是 'e007'
    expect(e007?.open_amount).toBe(480000); // PROPOSAL → 规范 Proposal → open
    expect(e008?.owner_name).toBe('罗宁');
    expect(e008?.won_amount).toBe(150000); // CUSTOMER → 规范 Closed Won → won
  });

  it('拆分姓名读回带空格（John Smith，非 JohnSmith）', async () => {
    const { fetchImpl } = makeFetch([
      { json: { data: { person: { ...PERSON, name: { firstName: 'John', lastName: 'Smith' } } } } },
    ]);
    const row = await backend(fetchImpl).getContact('p-1');
    expect(row?.name).toBe('John Smith');
  });

  it('自定义 ownerField：可改成映射到别的字段', async () => {
    const { fetchImpl } = makeFetch([
      { json: { data: { person: { ...PERSON, ownerId: undefined, assigneeId: 'e099' } } } },
    ]);
    const b = new TwentyRestBackend({
      baseUrl: 'https://crm.example.com',
      apiKey: 'k',
      ownerField: 'assigneeId',
      fetchImpl,
    });
    const row = await b.getContact('p-1');
    expect(row?.owner_id).toBe('e099');
  });

  it('非 404 失败 → 抛错，不透传正文', async () => {
    const fetchImpl = (async () =>
      new Response('<html>err</html>', { status: 500 })) as typeof fetch;
    await expect(backend(fetchImpl).getContact('x')).rejects.toThrow(/HTTP 500/);
  });
});

// 退款走 Twenty 自定义对象 Order/Refund；归属字段用 repCode（同线上配置）
function repBackend(fetchImpl: typeof fetch) {
  return new TwentyRestBackend({
    baseUrl: 'https://crm.example.com/',
    apiKey: 'k1',
    ownerField: 'repCode',
    fetchImpl,
  });
}
const ORDER = {
  id: 'o-1',
  name: 'ord-1001',
  email: 'chen@huasheng.example.com',
  lastFour: '4321',
  amountPaid: 480000,
  repCode: 'e007',
};

describe('TwentyRestBackend 退款（Order/Refund 自定义对象）', () => {
  it('getOrder：按 name 客户端匹配 → 统一行结构，owner_id 取 repCode', async () => {
    const { fetchImpl, requests } = makeFetch([{ json: { data: { orders: [ORDER] } } }]);
    const row = await repBackend(fetchImpl).getOrder('ord-1001');
    expect(requests[0]?.url).toBe('https://crm.example.com/rest/orders');
    expect(row).toEqual({
      order_id: 'ord-1001',
      account_id: '',
      email: 'chen@huasheng.example.com',
      last_four: '4321',
      amount_paid: 480000,
      currency: 'CNY',
      owner_id: 'e007',
    });
  });

  it('getOrder 查无此单 → null', async () => {
    const { fetchImpl } = makeFetch([{ json: { data: { orders: [ORDER] } } }]);
    expect(await repBackend(fetchImpl).getOrder('ord-9999')).toBeNull();
  });

  it('issueRefund 核验通过 → POST /refunds，归属随订单盖 repCode', async () => {
    const { fetchImpl, requests } = makeFetch([
      { json: { data: { orders: [ORDER] } } },
      { json: { data: { createRefund: { id: 'rf-9' } } } },
    ]);
    const res = await repBackend(fetchImpl).issueRefund({
      order_id: 'ord-1001',
      email: 'chen@huasheng.example.com',
      last_four: '4321',
      amount: 200,
    });
    expect(requests[1]?.method).toBe('POST');
    expect(requests[1]?.url).toBe('https://crm.example.com/rest/refunds');
    const body = requests[1]?.body as Record<string, unknown>;
    expect(body.repCode).toBe('e007');
    expect(body.orderCode).toBe('ord-1001');
    expect(body.amount).toBe(200);
    expect(body.status).toBe('issued');
    expect(res).toMatchObject({
      refund_id: 'rf-9',
      order_id: 'ord-1001',
      amount: 200,
      status: 'issued',
      owner_id: 'e007',
    });
  });

  it('issueRefund 卡尾号对不上 → 抛错，且不发 POST', async () => {
    const { fetchImpl, requests } = makeFetch([{ json: { data: { orders: [ORDER] } } }]);
    await expect(
      repBackend(fetchImpl).issueRefund({
        order_id: 'ord-1001',
        email: 'chen@huasheng.example.com',
        last_four: '0000',
        amount: 200,
      }),
    ).rejects.toThrow('身份核验');
    expect(requests).toHaveLength(1); // 只有 GET，没有 POST
  });

  it('issueRefund 金额超过已付 → 抛错', async () => {
    const { fetchImpl } = makeFetch([{ json: { data: { orders: [ORDER] } } }]);
    await expect(
      repBackend(fetchImpl).issueRefund({
        order_id: 'ord-1001',
        email: 'chen@huasheng.example.com',
        last_four: '4321',
        amount: 999_999_999,
      }),
    ).rejects.toThrow('超过订单已付');
  });

  it('refundCountThisMonth：按 repCode + 本月 createdAt 计数', async () => {
    const thisMonth = new Date().toISOString();
    const refunds = [
      { repCode: 'e007', createdAt: thisMonth },
      { repCode: 'e007', createdAt: thisMonth },
      { repCode: 'e008', createdAt: thisMonth }, // 别人的
      { repCode: 'e007', createdAt: '2020-01-01T00:00:00.000Z' }, // 上个月
    ];
    const { fetchImpl } = makeFetch([{ json: { data: { refunds } } }]);
    expect(await repBackend(fetchImpl).refundCountThisMonth('e007')).toBe(2);
  });

  it('issueRefund：POST /refunds 返 404（Refund 对象未配置）→ 抛错，绝不硬报成功', async () => {
    // 核验/金额全过，但退款实体没落库——必须 fail-closed，不能把没发生的退款当 issued
    const { fetchImpl, requests } = makeFetch([
      { json: { data: { orders: [ORDER] } } },
      { status: 404 },
    ]);
    await expect(
      repBackend(fetchImpl).issueRefund({
        order_id: 'ord-1001',
        email: 'chen@huasheng.example.com',
        last_four: '4321',
        amount: 200,
      }),
    ).rejects.toThrow('未返回退款实体');
    expect(requests).toHaveLength(2); // GET orders + POST refunds 都发了，但结果被拦
  });

  it('getOrder：翻页拉全量，命中落在后页的订单（首页不带参数，续页才带 cursor）', async () => {
    const { fetchImpl, requests } = makeFetch([
      {
        json: {
          data: { orders: [{ ...ORDER, name: 'ord-0001' }] },
          pageInfo: { hasNextPage: true, endCursor: 'cur-1' },
        },
      },
      { json: { data: { orders: [ORDER] }, pageInfo: { hasNextPage: false } } },
    ]);
    const row = await repBackend(fetchImpl).getOrder('ord-1001');
    expect(row?.order_id).toBe('ord-1001');
    expect(requests[0]?.url).toBe('https://crm.example.com/rest/orders');
    expect(requests[1]?.url).toBe('https://crm.example.com/rest/orders?starting_after=cur-1');
  });

  it('refundCountThisMonth：跨页累计，不因只读首页而少算（否则绕过频次闸门）', async () => {
    const thisMonth = new Date().toISOString();
    const { fetchImpl } = makeFetch([
      {
        json: {
          data: { refunds: [{ repCode: 'e007', createdAt: thisMonth }] },
          pageInfo: { hasNextPage: true, endCursor: 'c1' },
        },
      },
      {
        json: {
          data: { refunds: [{ repCode: 'e007', createdAt: thisMonth }] },
          pageInfo: { hasNextPage: false },
        },
      },
    ]);
    expect(await repBackend(fetchImpl).refundCountThisMonth('e007')).toBe(2);
  });
});
