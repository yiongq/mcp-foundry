# foundry-server 生产镜像：fixture/REST 单进程，无外部依赖、无模型下载。
# 身份走签名令牌——demo 头模式需显式 FOUNDRY_DEMO=1，缺签名身份时 serve 拒绝启动（fail-closed）。
#
# 硬化要点：基础镜像按摘要固定（可复现构建，Dependabot 负责升级）；tini 当 PID1 转发信号、
# 收割僵尸；容器以非 root 运行（逃逸不落到宿主 root）；HEALTHCHECK 探 /healthz；
# node 直接 exec（不经 pnpm）于是 SIGTERM 直达进程 → serve.ts 优雅关闭。
FROM node:25-slim@sha256:81db02c4b671288a03915da9534dbd54f96d0e7c24d80ccc54f5b36b2e684370

# tini：正确的 PID1，转发 SIGTERM 给 node（触发 serve.ts 优雅关闭）、收割任何孤儿进程
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN corepack enable

# 先拷清单层，装依赖的缓存与源码变更解耦
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapter-orangehrm/package.json packages/adapter-orangehrm/
COPY packages/adapter-twenty/package.json packages/adapter-twenty/
COPY packages/adapter-memory/package.json packages/adapter-memory/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @yiong/foundry-server...

COPY packages/core packages/core
COPY packages/adapter-orangehrm packages/adapter-orangehrm
COPY packages/adapter-twenty packages/adapter-twenty
COPY packages/adapter-memory packages/adapter-memory
COPY packages/server packages/server
COPY config config

# 非 root 运行：容器逃逸不落到宿主 root（宿主还存着审计签名私钥与各类密钥）。
# 审计目录归该用户所有——named volume 首次挂载会继承此属主，容器内可写。
# 迁移注意：既有 root 属主的旧卷需先 chown（见 DEPLOY-CHECKLIST）。
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin app \
  && mkdir -p /app/audit \
  && chown -R app:app /app/audit
USER app

ENV NODE_ENV=production
EXPOSE 3100

# 存活探针（Node 22 自带全局 fetch，无需 curl）。存活 ≠ 就绪：就绪查依赖走 /readyz。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3100)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# WORKDIR 切到 server 包，让 `--import tsx` 从其 node_modules 解析（config/audit 路径由
# serve.ts 的 import.meta.url 定位，与 CWD 无关）。tini 作 PID1，node 直接跑（非经 pnpm）。
WORKDIR /app/packages/server
ENTRYPOINT ["tini", "--"]
CMD ["node", "--import", "tsx", "bin/serve.ts"]
