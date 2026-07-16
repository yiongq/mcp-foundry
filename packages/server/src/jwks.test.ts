import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createJwksFileLoader, loadJwks } from './jwks.js';

function jwkJson(kid: string): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return JSON.stringify({ keys: [{ ...(publicKey.export({ format: 'jwk' }) as object), kid }] });
}

describe('loadJwks', () => {
  it('合法 EC JWKS 通过；空 keys / 重复 kid 拒绝', () => {
    expect(loadJwks(jwkJson('k1')).keys[0]?.kid).toBe('k1');
    expect(() => loadJwks('{"keys":[]}')).toThrow();

    const one = JSON.parse(jwkJson('dup')) as { keys: unknown[] };
    const dup = JSON.stringify({ keys: [one.keys[0], one.keys[0]] });
    expect(() => loadJwks(dup)).toThrow(/duplicate kid/);
  });
});

describe('createJwksFileLoader', () => {
  it('mtime 变化触发重载；重载解析失败沿用上一份有效集合', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jwks-'));
    const path = join(dir, 'jwks.json');

    writeFileSync(path, jwkJson('k1'));
    utimesSync(path, new Date(1_000_000), new Date(1_000_000));
    const load = createJwksFileLoader(path);
    expect(load().keys[0]?.kid).toBe('k1');

    // 轮换：覆盖新 kid + 拨 mtime → 下次调用即拿到新集合
    writeFileSync(path, jwkJson('k2'));
    utimesSync(path, new Date(2_000_000), new Date(2_000_000));
    expect(load().keys[0]?.kid).toBe('k2');

    // 半保存状态：坏 JSON 不炸验签，沿用 k2
    writeFileSync(path, '{ broken');
    utimesSync(path, new Date(3_000_000), new Date(3_000_000));
    expect(load().keys[0]?.kid).toBe('k2');
  });

  it('同 mtime 的吊销靠 size 兜住：紧急吊销不因时间戳碰撞 fail-open', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jwks-'));
    const path = join(dir, 'jwks.json');
    const pinned = new Date(5_000_000);

    // 两个 kid 的 JWKS 字节数不同——吊销覆盖后即使 mtime 被钉成同一刻，size 已变
    const twoKeys = (() => {
      const a = JSON.parse(jwkJson('revoked-kid-1')) as { keys: unknown[] };
      const b = JSON.parse(jwkJson('current-kid-2')) as { keys: unknown[] };
      return JSON.stringify({ keys: [a.keys[0], b.keys[0]] });
    })();
    writeFileSync(path, twoKeys);
    utimesSync(path, pinned, pinned);
    const load = createJwksFileLoader(path);
    expect(load().keys.map((k) => k.kid)).toContain('revoked-kid-1');

    // 紧急吊销：只留 current-kid-2，mtime 恰好碰撞到同一刻
    writeFileSync(path, jwkJson('current-kid-2'));
    utimesSync(path, pinned, pinned);
    const after = load().keys.map((k) => k.kid);
    expect(after).toEqual(['current-kid-2']); // 吊销即时生效，被吊销的 kid 不再验签
  });

  it('half-write 修复后即便 mtime 回到失败时刻也被重读（失败分支不推进版本）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jwks-'));
    const path = join(dir, 'jwks.json');

    writeFileSync(path, jwkJson('g1'));
    utimesSync(path, new Date(6_000_000), new Date(6_000_000));
    const load = createJwksFileLoader(path);
    expect(load().keys[0]?.kid).toBe('g1');

    // 半写：mtime 拨到 M2，解析失败 → 沿用 g1，但不把 M2 记为已加载版本
    writeFileSync(path, '{ half');
    const m2 = new Date(7_000_000);
    utimesSync(path, m2, m2);
    expect(load().keys[0]?.kid).toBe('g1');

    // 修复完成，写入 g2 且 mtime 仍停在 M2（size 变；即便 size 不变也应因上一步没推进版本而重读）
    writeFileSync(path, jwkJson('g2'));
    utimesSync(path, m2, m2);
    expect(load().keys[0]?.kid).toBe('g2');
  });

  it('首次加载失败直接抛——配置错误拒绝启动', () => {
    const dir = mkdtempSync(join(tmpdir(), 'jwks-'));
    const missing = createJwksFileLoader(join(dir, 'nope.json'));
    expect(() => missing()).toThrow();

    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"keys":[]}');
    expect(() => createJwksFileLoader(bad)()).toThrow();
  });
});
