/**
 * 商机 stage 词汇映射：Twenty 默认商机管线枚举 ↔ 本项目的规范 stage 词汇。
 *
 * 本项目（fixtures / 守卫 / get_pipeline_summary 的 won/open 分桶 / 评测题面）统一用规范词汇
 * （Proposal / Negotiation / Closed Won …）。Twenty 标准对象 opportunities 的 stage 是个 SELECT
 * 枚举，值是 NEW / SCREENING / MEETING / PROPOSAL / CUSTOMER——写进去必须用枚举值（写规范词
 * 会被 Twenty 静默丢弃、落成默认 NEW，这正是线上「所有商机都显示 NEW」的根因）。
 *
 * 于是 REST 路径两头都要翻译：读回时枚举→规范（否则 get_pipeline_summary 的 `=== 'Closed Won'`
 * 永不命中、盘点全归 open），写入/播种时规范→枚举。只作用于 REST（真库）路径；fixture 后端与
 * CI 的 fixture-eval 用的就是规范词汇、不经过这里。未收录的值原样透传（对 Twenty demo 自带数据
 * 或未来新增枚举都安全）。
 */

const TWENTY_TO_CANONICAL: Readonly<Record<string, string>> = {
  NEW: 'Prospecting',
  SCREENING: 'Screening',
  MEETING: 'Negotiation',
  PROPOSAL: 'Proposal',
  CUSTOMER: 'Closed Won',
};

const CANONICAL_TO_TWENTY: Readonly<Record<string, string>> = {
  Prospecting: 'NEW',
  Screening: 'SCREENING',
  Negotiation: 'MEETING',
  Proposal: 'PROPOSAL',
  'Closed Won': 'CUSTOMER',
};

/** Twenty 枚举 → 规范 stage。空/未收录原样返回。 */
export function twentyStageToCanonical(stage: string | null | undefined): string {
  if (!stage) return '';
  return TWENTY_TO_CANONICAL[stage] ?? stage;
}

/** 规范 stage → Twenty 枚举。未收录原样返回（让 Twenty 侧自己校验，宁可写失败也不静默落错）。 */
export function canonicalStageToTwenty(stage: string): string {
  return CANONICAL_TO_TWENTY[stage] ?? stage;
}
