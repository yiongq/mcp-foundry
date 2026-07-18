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
