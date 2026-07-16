/**
 * 身份令牌签发 CLI——演示里扮演"网关"这个身份权威的角色。
 *
 * FOUNDRY_IDENTITY_SECRET=… pnpm --filter @yiong/foundry-server run mint-token \
 *   --user e004 --role hr_admin [--ttl 3600]
 */
import { parseArgs } from 'node:util';
import { mintIdentityToken } from '../src/index.js';

const { values } = parseArgs({
  options: {
    user: { type: 'string' },
    role: { type: 'string' },
    ttl: { type: 'string', default: '3600' },
  },
  allowPositionals: true, // pnpm 可能把 "--" 原样传进来，别让它崩
});

const secret = process.env.FOUNDRY_IDENTITY_SECRET;
const ttl = Number(values.ttl);

if (!secret || !values.user || !values.role || !Number.isFinite(ttl) || ttl <= 0) {
  console.error(
    'usage: FOUNDRY_IDENTITY_SECRET=<16+ chars> pnpm --filter @yiong/foundry-server run mint-token --user <id> --role <role> [--ttl <seconds>]',
  );
  process.exit(1);
}

const token = mintIdentityToken(secret, { userId: values.user, role: values.role }, ttl);

console.log(token);
console.error(`\n# ${values.user} / ${values.role}, expires in ${ttl}s — try:`);
console.error(`curl -s http://localhost:3100/mcp \\
  -H 'content-type: application/json' \\
  -H 'accept: application/json, text/event-stream' \\
  -H 'authorization: Bearer ${token}' \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'`);
