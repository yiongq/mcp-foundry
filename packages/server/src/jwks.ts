/**
 * 受信公钥集（JWKS）：非对称验签（token-jwks 模式）的信任锚。
 *
 * 密钥轮换的形状：keys 里多个 kid 并存——签发方切到新私钥后，旧 kid 留在
 * 集合里撑过渡窗口（存量令牌自然过期），窗口结束把旧 JWK 删掉即吊销。
 *
 * 两种加载器、同一条纪律（首次失败拒绝启动；之后失败沿用上一份有效集合；
 * 失败分支不推进已记录版本），但契约与吊销时延不同：
 *
 * - 文件加载器：懒惰的同步工厂——构造零 I/O，调用方在启动期自己探一次
 *   （serve.ts 的「不带病上线」探针）。按 (mtime, size) 热重载，吊销在
 *   下一次请求即生效。
 * - URL 加载器：急切的异步工厂——首次拉取在工厂内 await，失败时服务器
 *   还没起来就拒绝启动，调用方无需再探。之后按固定间隔轮询刷新，吊销
 *   最迟一个刷新间隔生效；拉取端点持续故障时沿用旧集合、时延无上界
 *   （可用性优先于吊销时效，见 README 诚实边界）——紧急吊销而端点又
 *   恰好不可达时，重启网关即 fail-closed（启动拉不到密钥集就起不来）。
 *
 * 文件加载器新鲜度判据用 (mtime, size) 而非裸 mtime：紧急吊销 {k1}→{k2} 若恰好
 * 落在同一毫秒 mtime（保留时间戳的 rsync -a / cp -p、粗粒度 mtime 的 Docker 卷/
 * NFS 上 plausible），纯 mtime 判等会漏掉这次变更、继续拿被吊销的密钥验签
 * （fail-open）；加上 size 后同 mtime 的内容变更几乎必然 size 也变，把这个
 * fail-open 窗口收到「同 mtime + 同字节数 + 不同内容」的实际不可构造区间。
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

export interface JwksUrlLoaderOptions {
  /** 后台刷新间隔（毫秒）。固定轮询，不读 Cache-Control/max-age。默认 5 分钟。 */
  refreshMs?: number;
  /** 单次拉取超时（毫秒）。默认 10 秒。 */
  timeoutMs?: number;
  /** 响应体字节上限——按实际读到的字节数计数，不信任 Content-Length。默认 1 MiB。 */
  maxBytes?: number;
  /**
   * 可选 fail-closed 截止：距上一次成功刷新（200 或 304 都算成功）超过该时长后
   * load() 抛错——principal 侧统一转 401。不设则沿用旧集合、时延无上界
   * （可用性优先；代价是拿到私钥的攻击者只要打瘫刷新链路就能冻结吊销——
   * 部署方按威胁模型自选，见 README 诚实边界）。
   */
  maxStaleMs?: number;
}

export interface JwksUrlLoader {
  /** 同步返回当前缓存的密钥集（AuthConfig.jwks 直接吃这个函数）。 */
  load: () => IdentityJwks;
  /**
   * 手动触发一次刷新，与后台定时器共用同一个单飞 Promise——永不 reject，
   * 失败沿用旧集合并打警告。存在的意义是让测试确定性地驱动刷新，而不是
   * 等墙钟；生产调用方不需要碰它。
   */
  refresh: () => Promise<void>;
  /** 停掉后台刷新定时器（幂等）。 */
  stop: () => void;
}

/**
 * 信任锚只走 TLS；明文 http 仅放行**字面**回环地址（本地开发与测试）。
 * 不放行 "localhost"——那是个名字不是地址，改过的 /etc/hosts 能把明文
 * 拉取引出本机；本地场景写 127.0.0.1 一样方便。
 */
function assertTrustedJwksUrl(url: string): URL {
  const parsed = new URL(url);
  if (parsed.protocol === 'https:') return parsed;
  if (parsed.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(parsed.hostname)) {
    return parsed;
  }
  throw new Error(`JWKS URL must be https (plain http only for literal loopback): ${url}`);
}

/** setInterval 的延时超过 2^31-1 毫秒会被 Node 钳到 1ms——溢出即热循环，必须在构造期拒绝。 */
const MAX_INTERVAL_MS = 2_147_483_647;

/** 按实际字节数限长地读响应体：Content-Length 只作快速拒绝，不作信任依据。 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * 定时轮询的 JWKS URL 加载器（急切异步工厂，契约对比见文件头）。
 *
 * - 重定向按失败处理（redirect: 'error'）：https 起跳被 30x 引到明文/别的主机，
 *   等于信任锚换了运输通道——scheme 检查只管第一跳，所以干脆不跟。
 * - ETag/If-None-Match：304 → 沿用当前集合并视作一次成功刷新。ETag 只在
 *   「拉到且解析通过」之后才推进——坏 payload 若推进了 ETag，后续 304 会把
 *   坏版本"确认"下来、旧集合永远修不回去（与文件加载器不推进 loadedSig
 *   同一条纪律）。首次拉取就撞上 304（坏代理才会——我们没发 If-None-Match）
 *   没有集合可沿用，按启动失败处理。
 * - 后台定时器的回调整体不可抛（refresh 永不 reject）：逃逸的 rejection 在
 *   Node 默认策略下是进程崩溃——一次网络抖动不能变成网关停机。定时器
 *   unref()，不阻止进程退出。
 * - load() 里带请求驱动的懒刷新兜底：距上次尝试超过一个刷新间隔就顺手踢一次
 *   后台刷新（单飞限流）——CPU 节流/冻结的运行时（Cloud Run/Lambda）里
 *   定时器可能永远不跑，密钥集不能因此冻在启动那一刻。
 * - 信任锚的每次变更都留痕：初始集合与每次换代打 kid 清单/差集日志
 *   （只记 kid，不记密钥材料）——密钥集从网络来、没有人手经手，
 *   端点被黑塞进一把合规形状的野 kid 不能是无声的。
 */
export async function createJwksUrlLoader(
  url: string,
  opts: JwksUrlLoaderOptions = {},
): Promise<JwksUrlLoader> {
  const target = assertTrustedJwksUrl(url);
  const refreshMs = opts.refreshMs ?? 300_000;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const maxBytes = opts.maxBytes ?? 1_048_576;
  const maxStaleMs = opts.maxStaleMs;
  if (!Number.isFinite(refreshMs) || refreshMs <= 0 || refreshMs > MAX_INTERVAL_MS) {
    throw new Error(`refreshMs must be a positive number <= ${MAX_INTERVAL_MS}`);
  }
  // 下限 2×间隔+超时：陈旧度在稳态下就会合法地冲到「间隔 + 在途拉取时延」，
  // 还要容一次失败轮询——更紧的截止会对着完全健康的端点误伤 401
  if (
    maxStaleMs !== undefined &&
    (!Number.isFinite(maxStaleMs) || maxStaleMs < 2 * refreshMs + timeoutMs)
  ) {
    throw new Error('maxStaleMs must be >= 2 * refreshMs + timeoutMs');
  }

  let etag: string | null = null;
  let lastAttemptAt = 0;

  // kid 与错误消息可能携带对端字节（JWKS 从网络来）——进日志前压掉控制字符，防日志注入
  const oneLine = (s: string): string => s.replace(/\p{Cc}+/gu, ' ');
  const kidsOf = (jwks: IdentityJwks): string[] => jwks.keys.map((k) => oneLine(k.kid));

  // AbortSignal.timeout 的中止在 GC 压力下可能于读 body 中途丢失（undici 已知问题，
  // 本仓库在 Node 22 实测复现）——fetch 从此永不结算。硬截止保证每次刷新必然结算，
  // 单飞 Promise 不会被一条挂死的连接永久卡住（代价：被弃的连接可能滞留到对端收尾）。
  const withHardDeadline = async <T>(work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`JWKS fetch exceeded hard deadline (${2 * timeoutMs}ms)`)),
        2 * timeoutMs,
      );
      timer.unref();
    });
    try {
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** 拉一次：不动共享状态（etag 的推进在 applyOnce 的世代守卫内）。null = 304 内容未变。 */
  const fetchOnce = async (): Promise<{ jwks: IdentityJwks; etag: string | null } | null> => {
    lastAttemptAt = Date.now();
    const headers: Record<string, string> = { accept: 'application/json' };
    if (etag !== null) headers['if-none-match'] = etag;
    const res = await fetch(target, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers,
    });
    if (res.status === 304) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`HTTP ${res.status}`);
    }
    const body = await readBodyCapped(res, maxBytes);
    try {
      return { jwks: loadJwks(body), etag: res.headers.get('etag') };
    } catch (err) {
      // JSON.parse 的报错会回显响应体片段——换成固定文案，守住「不回显响应体」；
      // zod 的 schema 报错只含规则与路径（可能含 kid，出口统一过 oneLine），原样上抛
      if (err instanceof SyntaxError) throw new Error('invalid JSON in JWKS response');
      throw err;
    }
  };

  // 首次拉取失败在这里抛——服务器起不来，不带病上线
  const first = await withHardDeadline(fetchOnce());
  if (first === null) throw new Error('HTTP 304 on initial fetch (no cached key set to reuse)');
  let cached: IdentityJwks = first.jwks;
  etag = first.etag;
  let lastSuccessAt = Date.now();
  let failing = false;
  let generation = 0;
  console.log(`[auth] JWKS 已加载: ${target} kids=[${kidsOf(cached).join(', ')}]`);

  const applyOnce = async (): Promise<void> => {
    const gen = ++generation;
    const result = await fetchOnce();
    // 被硬截止淘汰后又迟到完成的旧尝试不得倒灌——它的内容可能比后来成功的那次更旧
    if (gen !== generation) return;
    if (result !== null) {
      const before = kidsOf(cached);
      const after = kidsOf(result.jwks);
      const added = after.filter((k) => !before.includes(k));
      const removed = before.filter((k) => !after.includes(k));
      if (added.length > 0 || removed.length > 0) {
        console.log(
          `[auth] JWKS 密钥集变更: ${target} +[${added.join(', ')}] -[${removed.join(', ')}] 现 ${after.length} 把`,
        );
      }
      cached = result.jwks;
      etag = result.etag;
    }
    if (failing) console.log(`[auth] JWKS 刷新恢复: ${target}`);
    failing = false;
    lastSuccessAt = Date.now();
  };

  let inFlight: Promise<void> | null = null;
  const refresh = (): Promise<void> => {
    inFlight ??= withHardDeadline(applyOnce())
      .catch((err: unknown) => {
        // 全捕获，不做错误类型白名单：超时/网络/非 2xx/坏 JSON/schema 拒绝
        // 一律沿用旧集合。只记 URL、原因与陈旧时长，不回显响应体。
        failing = true;
        const staleSeconds = Math.round((Date.now() - lastSuccessAt) / 1000);
        console.error(
          `[auth] JWKS 刷新失败，沿用上一份有效密钥集（已 ${staleSeconds}s 未成功刷新）: ${target} ${oneLine(err instanceof Error ? err.message : String(err))}`,
        );
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const timer = setInterval(() => void refresh(), refreshMs);
  timer.unref();

  return {
    load: () => {
      // 懒刷新兜底先踢（fail-closed 状态也要持续尝试自愈），再判陈旧截止
      if (Date.now() - lastAttemptAt > refreshMs) void refresh();
      if (maxStaleMs !== undefined && Date.now() - lastSuccessAt > maxStaleMs) {
        throw new Error(`JWKS stale beyond max-stale cutoff (${maxStaleMs}ms)`);
      }
      return cached;
    },
    refresh,
    stop: () => clearInterval(timer),
  };
}
