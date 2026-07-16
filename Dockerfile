# foundry-server 生产镜像：fixture 模式单进程，无外部依赖、无模型下载。
# 身份必须走签名令牌——FOUNDRY_IDENTITY_SECRET 由部署方注入（compose env_file），
# 不设密钥时 serve 会落回 demo 头模式并打警告，公网部署绝不允许。
FROM node:22-slim

WORKDIR /app
RUN corepack enable

# 先拷清单层，装依赖的缓存与源码变更解耦
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/adapter-orangehrm/package.json packages/adapter-orangehrm/
COPY packages/adapter-espocrm/package.json packages/adapter-espocrm/
COPY packages/adapter-memory/package.json packages/adapter-memory/
COPY packages/server/package.json packages/server/
RUN pnpm install --frozen-lockfile --filter @yiong/foundry-server...

COPY packages/core packages/core
COPY packages/adapter-orangehrm packages/adapter-orangehrm
COPY packages/adapter-espocrm packages/adapter-espocrm
COPY packages/adapter-memory packages/adapter-memory
COPY packages/server packages/server
COPY config config

# 审计日志写这里；compose 挂 named volume 使其随容器重建存活
RUN mkdir -p /app/audit

ENV NODE_ENV=production
EXPOSE 3100
CMD ["pnpm", "--filter", "@yiong/foundry-server", "serve"]
