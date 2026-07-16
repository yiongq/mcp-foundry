/**
 * 身份令牌签发 CLI——演示里扮演"网关/SSO"这个身份权威的角色。
 *
 * HS256（单网关共享密钥）：
 *   FOUNDRY_IDENTITY_SECRET=… pnpm --filter @yiong/foundry-server run mint-token \
 *     --user e004 --role hr_admin [--ttl 3600]
 * ES256（多签发方，配 keygen 生成的私钥 + JWKS）：
 *   pnpm --filter @yiong/foundry-server run mint-token \
 *     --key identity-es256.key --kid <kid> --user e004 --role hr_admin [--ttl 3600]
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { mintIdentityToken, mintIdentityTokenEs256 } from '../src/index.js';

const { values } = parseArgs({
  options: {
    user: { type: 'string' },
    role: { type: 'string' },
    ttl: { type: 'string', default: '3600' },
    key: { type: 'string' },
    kid: { type: 'string' },
  },
  allowPositionals: true, // pnpm 可能把 "--" 原样传进来，别让它崩
});

const usage = (): never => {
  console.error(
    [
      'usage:',
      '  HS256: FOUNDRY_IDENTITY_SECRET=<16+ chars> mint-token --user <id> --role <role> [--ttl <seconds>]',
      '  ES256: mint-token --key <private-key.pem> --kid <kid> --user <id> --role <role> [--ttl <seconds>]',
    ].join('\n'),
  );
  process.exit(1);
};

const ttl = Number(values.ttl);
if (!values.user || !values.role || !Number.isFinite(ttl) || ttl <= 0) usage();
const principal = { userId: values.user as string, role: values.role as string };

let token: string;
try {
  if (values.key !== undefined) {
    if (!values.kid) usage();
    token = mintIdentityTokenEs256(
      readFileSync(values.key, 'utf8'),
      values.kid as string,
      principal,
      ttl,
    );
  } else {
    const secret = process.env.FOUNDRY_IDENTITY_SECRET;
    if (!secret) usage();
    token = mintIdentityToken(secret as string, principal, ttl);
  }
} catch (err) {
  // 密钥文件缺失/非 EC 键/密钥太短——给一句人话，不甩裸栈
  console.error(`mint failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

console.log(token);
console.error(`\n# ${values.user} / ${values.role}, expires in ${ttl}s — try:`);
console.error(`curl -s http://localhost:3100/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -H 'authorization: Bearer ${token}' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`);
