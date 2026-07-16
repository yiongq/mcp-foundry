/**
 * 受信公钥集（JWKS）：非对称验签（token-jwks 模式）的信任锚。
 *
 * 密钥轮换的形状：keys 里多个 kid 并存——签发方切到新私钥后，旧 kid 留在
 * 集合里撑过渡窗口（存量令牌自然过期），窗口结束把旧 JWK 删掉即吊销。
 * 文件加载器按 (mtime, size) 热重载：SSO 轮换后覆盖 jwks.json 即生效，无需重启；
 * 重载解析失败沿用上一份有效密钥集（与 identity.feishu.yaml 同一条纪律——
 * 半保存状态的文件不能把验签炸停）。
 *
 * 新鲜度判据用 (mtime, size) 而非裸 mtime：紧急吊销 {k1}→{k2} 若恰好落在同一
 * 毫秒 mtime（保留时间戳的 rsync -a / cp -p、粗粒度 mtime 的 Docker 卷/NFS 上
 * plausible），纯 mtime 判等会漏掉这次变更、继续拿被吊销的密钥验签（fail-open）；
 * 加上 size 后同 mtime 的内容变更几乎必然 size 也变，把这个 fail-open 窗口收到
 * 「同 mtime + 同字节数 + 不同内容」的实际不可构造区间。重载失败分支**不推进**
 * 已记录版本——留在上一个成功版本，好让 half-write 修复完成后仍被重读。
 */
import { readFileSync, statSync } from 'node:fs';
import { z } from 'zod';

const ecJwkSchema = z.object({
  kty: z.literal('EC'),
  crv: z.literal('P-256'),
  x: z.string().min(1),
  y: z.string().min(1),
  kid: z.string().min(1),
});

const rsaJwkSchema = z
  .object({
    kty: z.literal('RSA'),
    n: z.string().min(1),
    e: z.string().min(1),
    kid: z.string().min(1),
  })
  // EC 分支钉死 P-256；RSA 对称地拒绝弱模数（<2048 位），不让配置误加一把弱信任锚
  .refine((k) => Buffer.from(k.n, 'base64url').length >= 256, {
    message: 'RSA modulus must be at least 2048 bits',
  });

const jwksSchema = z
  .object({
    keys: z.array(z.union([ecJwkSchema, rsaJwkSchema])).min(1),
  })
  .superRefine((jwks, ctx) => {
    const seen = new Set<string>();
    for (const key of jwks.keys) {
      if (seen.has(key.kid)) {
        // kid 是验签的查找键，重复即歧义——启动/重载期直接拒绝，不进运行时
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate kid "${key.kid}"` });
      }
      seen.add(key.kid);
    }
  });

export type IdentityPublicJwk = z.infer<typeof ecJwkSchema> | z.infer<typeof rsaJwkSchema>;
export type IdentityJwks = z.infer<typeof jwksSchema>;

export function loadJwks(jsonText: string): IdentityJwks {
  return jwksSchema.parse(JSON.parse(jsonText));
}

/**
 * mtime 热重载的 JWKS 文件加载器。首次加载失败直接抛（配置错误应拒绝启动）；
 * 之后的重载失败沿用上一份有效集合并打警告。
 */
export function createJwksFileLoader(path: string): () => IdentityJwks {
  let cached: IdentityJwks | null = null;
  let loadedSig = '';
  return () => {
    let sig: string;
    try {
      const st = statSync(path);
      sig = `${st.mtimeMs}:${st.size}`;
    } catch (err) {
      if (cached !== null) return cached;
      throw err;
    }
    if (cached === null || sig !== loadedSig) {
      try {
        cached = loadJwks(readFileSync(path, 'utf8'));
        loadedSig = sig;
      } catch (err) {
        if (cached === null) throw err;
        // 不推进 loadedSig：留在上一个成功版本，half-write 修复完成后仍会被重读
        console.error(
          `[auth] JWKS 重载失败，沿用上一份有效密钥集: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return cached;
  };
}
