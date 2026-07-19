/**
 * 把 fixture 演示数据灌进一个真实 Twenty 工作区(本地 Docker 或线上),让「本地测的真 Twenty」
 * 与「线上 Twenty」数据同源 —— 本地绿 = 线上绿。也用于线上重播:改数据 = 改 FIXTURE_* + 重跑本脚本,
 * 而不是手改生产记录(见 docs/local-twenty-testing.md)。
 *
 * 用法(从仓库根):
 *   TWENTY_API_URL=http://localhost:3000 TWENTY_API_KEY=<key> [TWENTY_OWNER_FIELD=repCode] \
 *     pnpm seed:twenty
 *
 * 前置:工作区需先建好自定义对象 Order(字段 name/email/lastFour/amountPaid/<owner>)——见
 * docs/twenty-notes.md。标准对象(companies/people/opportunities)无需额外建。幂等性由 Twenty
 * 侧决定:重复跑会产生重复记录,重播前建议清空工作区。
 */
import {
  FIXTURE_ACCOUNTS,
  FIXTURE_CONTACTS,
  FIXTURE_OPPORTUNITIES,
  FIXTURE_ORDERS,
} from '../src/fixtures.js';
import { canonicalStageToTwenty } from '../src/stage.js';

const baseUrl = (process.env.TWENTY_API_URL ?? '').replace(/\/+$/, '');
const apiKey = process.env.TWENTY_API_KEY ?? '';
const ownerField = process.env.TWENTY_OWNER_FIELD ?? 'repCode';

if (!baseUrl || !apiKey) {
  console.error('需要环境变量 TWENTY_API_URL + TWENTY_API_KEY(可选 TWENTY_OWNER_FIELD,缺省 repCode)');
  process.exit(1);
}

/** POST 一条记录,返回创建出的实体(取 data 下唯一对象值,如 createCompany/company)。 */
async function create(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${baseUrl}/rest${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → HTTP ${res.status}: ${await res.text()}`);
  const json = (await res.json()) as { data?: Record<string, unknown> };
  const data = json.data ?? {};
  const only = Object.values(data).find((v) => v !== null && typeof v === 'object');
  return (only ?? data) as Record<string, unknown>;
}

async function main(): Promise<void> {
  console.log(`播种目标:${baseUrl}(owner 字段=${ownerField})`);

  // 1) 客户(companies)——记录 fixture account_id → Twenty 生成的 UUID,供联系人/商机引用
  const companyUuid = new Map<string, string>();
  for (const a of FIXTURE_ACCOUNTS) {
    const c = await create('/companies', {
      name: a.name,
      ...(a.industry ? { industry: a.industry } : {}),
      ...(a.website ? { domainName: { primaryLinkUrl: a.website } } : {}),
      ...(a.city ? { address: { addressCity: a.city } } : {}),
      ...(a.phone ? { phone: a.phone } : {}),
      [ownerField]: a.owner_id,
    });
    companyUuid.set(a.account_id, String(c.id ?? ''));
  }
  console.log(`✓ ${FIXTURE_ACCOUNTS.length} 客户`);

  // 2) 联系人(people)——companyId 映射到真 UUID;整名入 lastName(读回由适配器拼接)
  for (const p of FIXTURE_CONTACTS) {
    const companyId = companyUuid.get(p.account_id);
    await create('/people', {
      name: { firstName: '', lastName: p.name },
      ...(p.title ? { jobTitle: p.title } : {}),
      ...(companyId ? { companyId } : {}),
      ...(p.email ? { emails: { primaryEmail: p.email } } : {}),
      ...(p.phone ? { phones: { primaryPhoneNumber: p.phone } } : {}),
      [ownerField]: p.owner_id,
    });
  }
  console.log(`✓ ${FIXTURE_CONTACTS.length} 联系人`);

  // 3) 商机(opportunities)——元换算回 amountMicros(百万分之一)
  for (const o of FIXTURE_OPPORTUNITIES) {
    const companyId = companyUuid.get(o.account_id);
    await create('/opportunities', {
      name: o.name,
      ...(companyId ? { companyId } : {}),
      // 规范 stage → Twenty 枚举（写规范词会被 Twenty 静默落成 NEW，见 src/stage.ts）
      ...(o.stage ? { stage: canonicalStageToTwenty(o.stage) } : {}),
      amount: { amountMicros: o.amount * 1_000_000 },
      // Twenty closeDate 是 DATE_TIME，须给完整 ISO（仅给日期会不落库）
      ...(o.close_date ? { closeDate: `${o.close_date}T00:00:00.000Z` } : {}),
      [ownerField]: o.owner_id,
    });
  }
  console.log(`✓ ${FIXTURE_OPPORTUNITIES.length} 商机`);

  // 4) 订单(自定义对象 Order;工作区需先建好,见 docs/twenty-notes.md)——退款身份核验锚点
  for (const ord of FIXTURE_ORDERS) {
    await create('/orders', {
      name: ord.order_id,
      email: ord.email,
      lastFour: ord.last_four,
      amountPaid: ord.amount_paid,
      [ownerField]: ord.owner_id,
    });
  }
  console.log(`✓ ${FIXTURE_ORDERS.length} 订单`);

  console.log('播种完成。');
}

main().catch((err: unknown) => {
  console.error(`播种失败:${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
