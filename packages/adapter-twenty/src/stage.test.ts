import { describe, expect, it } from 'vitest';
import { canonicalStageToTwenty, twentyStageToCanonical } from './stage.js';

describe('stage 词汇映射（Twenty 枚举 ↔ 规范）', () => {
  it('读回：Twenty 枚举 → 规范（won 分桶靠的 Closed Won 得到还原）', () => {
    expect(twentyStageToCanonical('CUSTOMER')).toBe('Closed Won');
    expect(twentyStageToCanonical('PROPOSAL')).toBe('Proposal');
    expect(twentyStageToCanonical('NEW')).toBe('Prospecting');
  });

  it('写入：规范 → Twenty 枚举（避免写规范词被静默落成 NEW）', () => {
    expect(canonicalStageToTwenty('Closed Won')).toBe('CUSTOMER');
    expect(canonicalStageToTwenty('Proposal')).toBe('PROPOSAL');
    expect(canonicalStageToTwenty('Negotiation')).toBe('MEETING');
  });

  it('往返稳定：规范 → Twenty → 规范', () => {
    for (const s of ['Prospecting', 'Screening', 'Negotiation', 'Proposal', 'Closed Won']) {
      expect(twentyStageToCanonical(canonicalStageToTwenty(s))).toBe(s);
    }
  });

  it('空值与未收录值原样透传（对 fixture 规范值/Twenty 自带 demo 数据都安全）', () => {
    expect(twentyStageToCanonical('')).toBe('');
    expect(twentyStageToCanonical(null)).toBe('');
    expect(twentyStageToCanonical('Proposal')).toBe('Proposal'); // 已是规范值
    expect(canonicalStageToTwenty('Closed Lost')).toBe('Closed Lost'); // Twenty 无对应枚举
  });
});
