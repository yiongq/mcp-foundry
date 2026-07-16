/**
 * ES256 签发密钥对生成——演示里扮演"独立签发方"的第一步。
 *
 * pnpm --filter @yiong/foundry-server run keygen \
 *   [--kid 2026-07] [--out identity-es256.key] [--jwks-out jwks.json]
 *
 * 私钥 PEM 写盘（0600，属签发方，绝不进仓库/不上传）；公钥 JWKS 也直接落盘
 * （不走 stdout——pnpm 的脚本横幅会污染重定向），设 FOUNDRY_IDENTITY_JWKS=<路径>
 * 即切 token-jwks 模式。轮换：再跑一次换新 kid + --jwks-out 临时文件，把新 JWK
 * 追加进在用 jwks.json 的 keys（新旧并存过渡），签发方切新私钥；
 * 过渡期结束删旧 JWK 即吊销旧键。
 */
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    kid: { type: 'string' },
    out: { type: 'string', default: 'identity-es256.key' },
    'jwks-out': { type: 'string', default: 'jwks.json' },
  },
  allowPositionals: true, // pnpm 可能把 "--" 原样传进来，别让它崩
});

const kid = values.kid ?? randomBytes(4).toString('hex');
const jwksOut = values['jwks-out'];

// 私钥必须落到 .gitignore 覆盖的扩展名（.key/.pem）——从工具侧堵死"随手命名的私钥被 git add"
if (!/\.(key|pem)$/.test(values.out)) {
  console.error(`private key --out must end in .key or .pem (got "${values.out}") — 防止私钥误入仓库`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = publicKey.export({ format: 'jwk' }) as Record<string, string>;

// 原子写：'wx' = O_CREAT|O_EXCL|O_WRONLY，已存在即抛（不跟随悬空 symlink），
// 把"检查是否存在"与"写"合成一步——existsSync-then-write 有 TOCTOU 竞态。
// 私钥/在用密钥集都不可静默覆盖：轮换应显式合并，不是重写。
try {
  writeFileSync(values.out, privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    mode: 0o600,
    flag: 'wx',
  });
  writeFileSync(jwksOut, `${JSON.stringify({ keys: [{ ...jwk, kid }] }, null, 2)}\n`, { flag: 'wx' });
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  console.error(
    code === 'EEXIST'
      ? `refusing to overwrite existing file (轮换请手动把新 JWK 合并进在用的 jwks.json)`
      : err instanceof Error
        ? err.message
        : String(err),
  );
  process.exit(1);
}

console.log(`# 私钥 → ${values.out}（0600）；公钥 JWKS → ${jwksOut}（kid: ${kid}）。接下来：`);
console.log(`#   FOUNDRY_IDENTITY_JWKS=${jwksOut} pnpm --filter @yiong/foundry-server serve`);
console.log(
  `#   pnpm --filter @yiong/foundry-server run mint-token --key ${values.out} --kid ${kid} --user e004 --role hr_admin`,
);
