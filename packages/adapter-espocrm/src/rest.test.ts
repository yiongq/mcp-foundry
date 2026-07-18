import { describe, expect, it } from 'vitest';
import { EspoCrmRestWriter } from './rest.js';

interface CapturedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function makeFetch(responses: Array<{ status?: number; json?: unknown }>): {
  fetchImpl: typeof fetch;
  requests: CapturedRequest[];
} {
  const requests: CapturedRequest[] = [];
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
    return new Response(status === 404 ? null : JSON.stringify(spec.json ?? {}), { status });
  }) as typeof fetch;
  return { fetchImpl, requests };
}

const CONTACT_ENTITY = {
  id: 'abc123',
  name: '赵新客',
  title: '总经理',
  accountId: 'a001',
  assignedUserId: 'e007',
  emailAddress: 'zhao@example.com',
  phoneNumber: '13800000000',
};

describe('EspoCrmRestWriter', () => {
  it('createContact：POST /api/v1/Contact，X-Api-Key 头，中文名入 lastName，归属入 assignedUserId', async () => {
    const { fetchImpl, requests } = makeFetch([{ json: CONTACT_ENTITY }]);
    const writer = new EspoCrmRestWriter({
      baseUrl: 'https://crm.example.com/',
      apiKey: 'k1',
      fetchImpl,
    });

    const row = await writer.createContact({ name: '赵新客', title: '总经理', owner_id: 'e007' });

    expect(requests[0]?.url).toBe('https://crm.example.com/api/v1/Contact');
    expect(requests[0]?.method).toBe('POST');
    expect(requests[0]?.headers['X-Api-Key']).toBe('k1');
    expect(requests[0]?.body).toEqual({
      lastName: '赵新客',
      title: '总经理',
      assignedUserId: 'e007',
    });
    expect(row).toEqual({
      contact_id: 'abc123',
      name: '赵新客',
      title: '总经理',
      account_id: 'a001',
      owner_id: 'e007',
      email: 'zhao@example.com',
      phone: '13800000000',
    });
  });

  it('updateContact：PUT 只带给到的字段；404 → null', async () => {
    const { fetchImpl, requests } = makeFetch([{ json: CONTACT_ENTITY }]);
    const writer = new EspoCrmRestWriter({
      baseUrl: 'https://crm.example.com',
      apiKey: 'k1',
      fetchImpl,
    });

    await writer.updateContact('abc123', { title: '副总裁' });
    expect(requests[0]?.method).toBe('PUT');
    expect(requests[0]?.url).toBe('https://crm.example.com/api/v1/Contact/abc123');
    expect(requests[0]?.body).toEqual({ title: '副总裁' });

    const { fetchImpl: fetch404 } = makeFetch([{ status: 404 }]);
    const writerMiss = new EspoCrmRestWriter({
      baseUrl: 'https://crm.example.com',
      apiKey: 'k1',
      fetchImpl: fetch404,
    });
    expect(await writerMiss.updateContact('nope', { title: 'x' })).toBeNull();
  });

  it('deleteContact：先 GET 取行再 DELETE，返回被删行；GET 404 时不发 DELETE', async () => {
    const { fetchImpl, requests } = makeFetch([{ json: CONTACT_ENTITY }, { json: true }]);
    const writer = new EspoCrmRestWriter({
      baseUrl: 'https://crm.example.com',
      apiKey: 'k1',
      fetchImpl,
    });

    const row = await writer.deleteContact('abc123');
    expect(requests.map((r) => r.method)).toEqual(['GET', 'DELETE']);
    expect(row?.contact_id).toBe('abc123');

    const { fetchImpl: fetch404, requests: missRequests } = makeFetch([{ status: 404 }]);
    const writerMiss = new EspoCrmRestWriter({
      baseUrl: 'https://crm.example.com',
      apiKey: 'k1',
      fetchImpl: fetch404,
    });
    expect(await writerMiss.deleteContact('nope')).toBeNull();
    expect(missRequests).toHaveLength(1);
  });

  it('updateOpportunityStage：PUT /Opportunity/{id}，实体映射回统一行结构', async () => {
    const { fetchImpl, requests } = makeFetch([
      {
        json: {
          id: 'o001',
          name: '华胜产线扩建设备采购',
          accountId: 'a001',
          stage: 'Closed Won',
          amount: 480000,
          amountCurrency: 'CNY',
          probability: 100,
          closeDate: '2026-09-30',
          assignedUserId: 'e007',
        },
      },
    ]);
    const writer = new EspoCrmRestWriter({
      baseUrl: 'https://crm.example.com',
      apiKey: 'k1',
      fetchImpl,
    });

    const row = await writer.updateOpportunityStage('o001', 'Closed Won');
    expect(requests[0]?.body).toEqual({ stage: 'Closed Won' });
    expect(row?.stage).toBe('Closed Won');
    expect(row?.owner_id).toBe('e007');
  });

  it('非 404 失败：抛错并带上 X-Status-Reason，不透传正文', async () => {
    const fetchImpl = (async () =>
      new Response('<html>boom</html>', {
        status: 403,
        headers: { 'X-Status-Reason': 'API key is not valid' },
      })) as typeof fetch;
    const writer = new EspoCrmRestWriter({
      baseUrl: 'https://crm.example.com',
      apiKey: 'bad',
      fetchImpl,
    });

    await expect(writer.updateContact('abc', { title: 'x' })).rejects.toThrow(
      /HTTP 403.*API key is not valid/,
    );
  });
});
