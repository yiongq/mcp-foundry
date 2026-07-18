/**
 * 离线校验签名审计哈希链——把「日志没被动过」变成可复现的密码学事实。
 * 只需公钥，不碰私钥，可在任意机器上跑（合规/取证方也能独立复核）。
 *
 * pnpm --filter @yiong/foundry-server run verify-audit \
 *   --file audit/foundry.jsonl --pubkey audit-ed25519.pub [--expect-last <hash>]
 *
 * 链完整 → 打印条数 + 末条 hash、exit 0；任一处断裂 → 报第一处 seq + 原因、exit 1。
 * 尾部截断（删掉最近 K 条）会留下一段更短但自洽的合法链——哈希链本身抓不到。
 * 传 --expect-last <外部锚定的末条 hash> 即可抓出：末条对不上 → exit 1。
 */
import { createPublicKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseSignedAuditLog, verifyAuditChain } from '@yiong/foundry-core';

const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    pubkey: { type: 'string' },
    'expect-last': { type: 'string' },
  },
  allowPositionals: true,
});

if (!values.file || !values.pubkey) {
  console.error(
    'usage: verify-audit --file <audit.jsonl> --pubkey <ed25519-public.pem> [--expect-last <hash>]',
  );
  process.exit(1);
}

let result: ReturnType<typeof verifyAuditChain>;
let lastHash: string;
try {
  const publicKey = createPublicKey(readFileSync(values.pubkey, 'utf8'));
  const records = parseSignedAuditLog(readFileSync(values.file, 'utf8'));
  result = verifyAuditChain(records, publicKey);
  lastHash = records.at(-1)?.hash ?? '0'.repeat(64);
} catch (err) {
  console.error(`verify failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (!result.ok) {
  console.error(
    `✗ 审计链断裂 @ seq ${result.brokenAt?.seq}：${result.brokenAt?.reason}（共 ${result.count} 条记录）`,
  );
  process.exit(1);
}

// 尾部截断防线：哈希链本身抓不到「删掉最近 K 条」，靠外部锚定的末条 hash 比对
if (values['expect-last'] !== undefined && values['expect-last'] !== lastHash) {
  console.error(
    `✗ 末条 hash 与外部锚定不符——疑似尾部截断（期望 ${values['expect-last'].slice(0, 16)}…，实际 ${lastHash.slice(0, 16)}…，共 ${result.count} 条）`,
  );
  process.exit(1);
}

console.log(
  `✓ 审计链完整：${result.count} 条记录，seq 连续、prevHash 链接、全部 Ed25519 验签通过。`,
);
console.log(`  末条 hash：${lastHash}（外部锚定此值即可抓尾部截断）`);
process.exit(0);
