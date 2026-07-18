/**
 * 审计签名密钥对生成（Ed25519）——防篡改审计的签发方密钥。
 *
 * pnpm --filter @yiong/foundry-server run audit-keygen \
 *   [--out audit-ed25519.key] [--pub-out audit-ed25519.pub]
 *
 * 私钥 PEM 写盘（0600、只允许 .key/.pem 扩展名，从工具侧堵死误入仓库），交网关签发方；
 * 公钥 PEM 随日志分发给校验方（verify-audit）。私钥不在服务器上，服务器只能生产
 * 可验证的记录、无法伪造历史——与身份 JWKS 同一条纪律。
 */
import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    out: { type: 'string', default: 'audit-ed25519.key' },
    'pub-out': { type: 'string', default: 'audit-ed25519.pub' },
  },
  allowPositionals: true, // pnpm 可能把 "--" 原样传进来，别让它崩
});

if (!/\.(key|pem)$/.test(values.out)) {
  console.error(`private key --out must end in .key or .pem (got "${values.out}") — 防止私钥误入仓库`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');

// 原子写：'wx' 已存在即抛，不静默覆盖已在用的密钥（轮换应显式换文件名）。
try {
  writeFileSync(values.out, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx',
  });
  writeFileSync(values['pub-out'], publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx' });
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  console.error(
    code === 'EEXIST'
      ? 'refusing to overwrite existing file（轮换请换个 --out 文件名）'
      : err instanceof Error
        ? err.message
        : String(err),
  );
  process.exit(1);
}

console.log(`# 审计私钥 → ${values.out}（0600，交网关）；公钥 → ${values['pub-out']}（随日志分发给校验方）。接下来：`);
console.log(`#   FOUNDRY_AUDIT_SIGNING_KEY=${values.out} pnpm --filter @yiong/foundry-server serve`);
console.log(
  `#   pnpm --filter @yiong/foundry-server run verify-audit --file audit/foundry.jsonl --pubkey ${values['pub-out']}`,
);
