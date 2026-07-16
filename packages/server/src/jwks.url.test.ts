/**
 * URL 加载器：对真实 node:http 端点验证拉取/刷新/降级行为（不 mock fetch——
 * 传输层行为如 redirect: 'error'、304、限长读流正是被测对象）。
 * 定时器不参与测试：refreshMs 拉长，全部用 loader.refresh() 确定性驱动。
 */
import { generateKeyPairSync } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import { createJwksUrlLoader } from './jwks.js';

function jwkJson(kid: string): string {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return JSON.stringify({ keys: [{ ...(publicKey.export({ format: 'jwk' }) as object), kid }] });
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

/** 可换 handler 的本地 JWKS 端点；close 前断掉挂起连接（超时用例会留下不收尾的 socket）。 */
async function startEndpoint(initial: Handler) {
  let handler = initial;
  const server = createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/jwks.json`,
    respond(next: Handler): void {
      handler = next;
    },
    async close(): Promise<void> {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

const serveJson = (body: string, etag?: string): Handler => {
  return (req, res) => {
    if (etag !== undefined && req.headers['if-none-match'] === etag) {
      res.statusCode = 304;
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (etag !== undefined) res.setHeader('etag', etag);
    res.end(body);
  };
};

const QUIET_REFRESH = { refreshMs: 3_600_000 };

describe('createJwksUrlLoader', () => {
  it('首次拉取成功 → load() 同步返回密钥集；轮换后 refresh() 拿到新 kid', async () => {
    const endpoint = await startEndpoint(serveJson(jwkJson('k1')));
    const loader = await createJwksUrlLoader(endpoint.url, QUIET_REFRESH);
    try {
      expect(loader.load().keys[0]?.kid).toBe('k1');

      endpoint.respond(serveJson(jwkJson('k2')));
      await loader.refresh();
      expect(loader.load().keys[0]?.kid).toBe('k2');
    } finally {
      loader.stop();
      await endpoint.close();
    }
  });

  it('ETag 命中 → 304 视作成功刷新，沿用当前集合', async () => {
    const endpoint = await startEndpoint(serveJson(jwkJson('e1'), '"v1"'));
    const loader = await createJwksUrlLoader(endpoint.url, QUIET_REFRESH);
    try {
      expect(loader.load().keys[0]?.kid).toBe('e1');
      await loader.refresh(); // If-None-Match: "v1" → 304
      expect(loader.load().keys[0]?.kid).toBe('e1');

      // 内容真变了（新 etag）→ 正常换代
      endpoint.respond(serveJson(jwkJson('e2'), '"v2"'));
      await loader.refresh();
      expect(loader.load().keys[0]?.kid).toBe('e2');
    } finally {
      loader.stop();
      await endpoint.close();
    }
  });

  it('刷新失败（非 2xx / 坏 JSON / schema 拒绝）→ refresh 不 reject，沿用上一份有效集合', async () => {
    const endpoint = await startEndpoint(serveJson(jwkJson('good')));
    const loader = await createJwksUrlLoader(endpoint.url, QUIET_REFRESH);
    try {
      endpoint.respond((_req, res) => {
        res.statusCode = 500;
        res.end('boom');
      });
      await loader.refresh();
      expect(loader.load().keys[0]?.kid).toBe('good');

      endpoint.respond(serveJson('{ broken'));
      await loader.refresh();
      expect(loader.load().keys[0]?.kid).toBe('good');

      endpoint.respond(serveJson('{"keys":[]}'));
      await loader.refresh();
      expect(loader.load().keys[0]?.kid).toBe('good');
    } finally {
      loader.stop();
      await endpoint.close();
    }
  });

  it('坏 payload 不推进 ETag：修复后即便复用失败时刻的 etag 也会被重新拉取', async () => {
    // good(v1) → broken(v2) → fixed(v2)。若失败分支错误地把 etag 推进到 v2，
    // 第三步会 304 把坏版本"确认"下来，永远卡在 g1（与文件加载器不推进 loadedSig 同一条纪律）。
    const endpoint = await startEndpoint(serveJson(jwkJson('g1'), '"v1"'));
    const loader = await createJwksUrlLoader(endpoint.url, QUIET_REFRESH);
    try {
      endpoint.respond(serveJson('{ broken', '"v2"'));
      await loader.refresh();
      expect(loader.load().keys[0]?.kid).toBe('g1');

      endpoint.respond(serveJson(jwkJson('g2'), '"v2"'));
      await loader.refresh();
      expect(loader.load().keys[0]?.kid).toBe('g2');
    } finally {
      loader.stop();
      await endpoint.close();
    }
  });

  it('响应超限 → 按实际读到的字节数拒绝，沿用旧集合（不信任 Content-Length）', async () => {
    // 超限 payload 本身是**完全合法**的 JWKS（空白填充凑字节数）——若实现没数着读
    // （比如直接 res.text()），它会解析成功、密钥集被换代，测试立刻失败；
    // 用无效字节凑超限分不清"被限长拒绝"和"parse 失败"，钉不住这个性质
    const paddedValid = `${jwkJson('cap-2')}${' '.repeat(4096)}`;
    const endpoint = await startEndpoint(serveJson(jwkJson('cap')));
    const loader = await createJwksUrlLoader(endpoint.url, { ...QUIET_REFRESH, maxBytes: 1024 });
    try {
      // chunked 响应（无 Content-Length）——快速拒绝分支帮不上，必须数着读
      endpoint.respond((_req, res) => {
        res.write(paddedValid);
        res.end();
      });
      await loader.refresh();
      expect(loader.load().keys[0]?.kid).toBe('cap');

      // 首拉超限同样拒绝启动，且报的是限长错误而不是 parse 错误
      await expect(
        createJwksUrlLoader(endpoint.url, { ...QUIET_REFRESH, maxBytes: 1024 }),
      ).rejects.toThrow(/exceeds/);
    } finally {
      loader.stop();
      await endpoint.close();
    }
  });

  it('可选 max-stale 截止：超时 fail-closed（load 抛 → principal 侧 401），刷新成功后自愈', async () => {
    const endpoint = await startEndpoint(serveJson(jwkJson('s1')));
    const loader = await createJwksUrlLoader(endpoint.url, {
      refreshMs: 100,
      timeoutMs: 50,
      maxStaleMs: 250, // 下限 = 2×refreshMs + timeoutMs
    });
    loader.stop(); // 掐掉定时器，测试自己驱动
    try {
      expect(loader.load().keys[0]?.kid).toBe('s1');
      await new Promise((resolve) => setTimeout(resolve, 400));
      // 已越过 max-stale：fail-closed；load 内部的懒刷新兜底会踢一次后台自愈
      expect(() => loader.load()).toThrow(/stale/);
      await loader.refresh();
      expect(loader.load().keys[0]?.kid).toBe('s1');
    } finally {
      loader.stop();
      await endpoint.close();
    }
  });

  it('304 也算成功刷新：新鲜度由「最后一次成功验证」而非「最后一次内容变更」定义', async () => {
    const endpoint = await startEndpoint(serveJson(jwkJson('s304'), '"v1"'));
    const loader = await createJwksUrlLoader(endpoint.url, {
      refreshMs: 100,
      timeoutMs: 50,
      maxStaleMs: 250,
    });
    loader.stop();
    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      await loader.refresh(); // If-None-Match 命中 → 304：内容没变，但新鲜度必须被续期
      expect(loader.load().keys[0]?.kid).toBe('s304'); // 若 304 不更新 lastSuccessAt，这里会抛 stale
    } finally {
      loader.stop();
      await endpoint.close();
    }
  });

  it('定时器不跑（CPU 节流运行时）也不冻结：load() 的懒刷新兜底把轮换带进来', async () => {
    const endpoint = await startEndpoint(serveJson(jwkJson('lazy-1')));
    const loader = await createJwksUrlLoader(endpoint.url, { refreshMs: 50 });
    loader.stop(); // 模拟定时器永不触发
    try {
      endpoint.respond(serveJson(jwkJson('lazy-2')));
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(loader.load().keys[0]?.kid).toBe('lazy-1'); // 同步返回旧集合，顺手踢后台刷新
      // 只靠 load() 驱动（不手动 refresh()）：新集合最终到位才证明踢真的发生了——
      // 手动 refresh() 会掩盖「踢」被删掉的回归
      await expect
        .poll(() => loader.load().keys[0]?.kid, { interval: 25, timeout: 2000 })
        .toBe('lazy-2');
    } finally {
      loader.stop();
      await endpoint.close();
    }
  });

  it('首次拉取失败 → 工厂 reject，拒绝启动（404 / 304 / 连不上 / 挂起超时 / 重定向）', async () => {
    const endpoint = await startEndpoint((_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    try {
      await expect(createJwksUrlLoader(endpoint.url, QUIET_REFRESH)).rejects.toThrow(/HTTP 404/);

      // 首拉就 304（我们没发 If-None-Match，只有坏代理才会）——没有集合可沿用，拒绝启动
      endpoint.respond((_req, res) => {
        res.statusCode = 304;
        res.end();
      });
      await expect(createJwksUrlLoader(endpoint.url, QUIET_REFRESH)).rejects.toThrow(/304/);

      // 重定向按失败处理：Location 指向一个**活着的、内容完全合法**的端点——
      // 若实现跟了 30x（redirect: 'follow'），这里会"成功"加载 lured kid 而不是 reject；
      // 指向死端口的重定向钉不住这个性质（跟过去连不上，一样 reject）
      const lure = await startEndpoint(serveJson(jwkJson('lured')));
      try {
        endpoint.respond((_req, res) => {
          res.statusCode = 302;
          res.setHeader('location', lure.url);
          res.end();
        });
        await expect(createJwksUrlLoader(endpoint.url, QUIET_REFRESH)).rejects.toThrow();
      } finally {
        await lure.close();
      }

      // 挂起不响应 → 超时拒绝
      endpoint.respond(() => {});
      await expect(
        createJwksUrlLoader(endpoint.url, { ...QUIET_REFRESH, timeoutMs: 200 }),
      ).rejects.toThrow();

      // headers 已发、body 挂起 → 同样超时拒绝（读流阶段也在超时/硬截止保护内）
      endpoint.respond((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
      });
      await expect(
        createJwksUrlLoader(endpoint.url, { ...QUIET_REFRESH, timeoutMs: 200 }),
      ).rejects.toThrow();
    } finally {
      await endpoint.close();
    }

    // 端点已关：连不上也 reject
    await expect(
      createJwksUrlLoader('http://127.0.0.1:9/jwks.json', QUIET_REFRESH),
    ).rejects.toThrow();
  });

  it('信任锚只走 TLS：非字面回环的明文 http 在构造期拒绝（localhost 是名字不是地址，不放行）', async () => {
    await expect(createJwksUrlLoader('http://example.com/jwks.json')).rejects.toThrow(/https/);
    await expect(createJwksUrlLoader('http://localhost:3100/jwks.json')).rejects.toThrow(/https/);
    await expect(createJwksUrlLoader('ftp://127.0.0.1/jwks.json')).rejects.toThrow(/https/);
  });

  it('刷新间隔与 max-stale 的边界在构造期拒绝：溢出钳 1ms 的热循环、比刷新还短的截止', async () => {
    const endpoint = await startEndpoint(serveJson(jwkJson('b1')));
    try {
      await expect(createJwksUrlLoader(endpoint.url, { refreshMs: 2_147_483_648 })).rejects.toThrow(
        /refreshMs/,
      );
      await expect(
        createJwksUrlLoader(endpoint.url, { refreshMs: 1000, maxStaleMs: 500 }),
      ).rejects.toThrow(/maxStaleMs/);
    } finally {
      await endpoint.close();
    }
  });
});
