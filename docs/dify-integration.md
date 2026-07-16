# Dify 接入指南（已验证：2026-07-16，Dify 1.16 本地 Docker）

foundry 是标准 Streamable HTTP MCP server，Dify 把它挂成 MCP 工具源即可——
**foundry 侧零代码改动，纯配置接入**。这份文档记录已实测跑通的完整步骤、
四个真实踩过的坑，以及搬到 VPS 的部署方案。

## 演示效果（实测）

同一句「张三的工资是多少」，两个 Dify Agent 应用（同一个 foundry 地址，只有令牌不同）：

| | 员工助手（employee 令牌） | HR 助手（hr_admin 令牌） |
|---|---|---|
| Dify 工具面 | 3 个工具，**没有 get_salary** | 4 个工具 |
| 问工资 | 「无法查询工资信息，当前工具只能查看花名册…」 | list_employees → get_salary → 18500 CNY |
| 审计 | — | 两条 ALLOW 流水（userId=e004） |

关键点：员工侧不是模型忍住不说——Dify 的工具列表里 `get_salary` 根本不存在
（在 Dify 的 MCP 管理界面肉眼可见），模型没有可调的东西。W3 签名令牌在此闭环：
令牌里是谁，Dify 看到的就是谁的工具面。

## 步骤

### 1. foundry 网关（token 模式）

```bash
export FOUNDRY_IDENTITY_SECRET='<16+ 字符密钥>'
pnpm --filter @yiong/foundry-server serve   # → :3100/mcp

# 两枚长效演示令牌（Dify 配置里用，别过期）
pnpm --filter @yiong/foundry-server run mint-token --user e002 --role employee --ttl 2592000
pnpm --filter @yiong/foundry-server run mint-token --user e004 --role hr_admin --ttl 2592000
```

### 2. Dify 侧放行私网目标（仅 foundry 与 Dify 同宿主时需要）

Dify 的 api 容器出站流量走 ssrf_proxy（squid），**默认拒绝所有私网目标**，
表现为连接 MCP server 时报 403。官方预留了白名单环境变量，`docker/.env` 加：

```bash
SSRF_PROXY_ALLOW_PRIVATE_DOMAINS=host.docker.internal
```

然后 `docker compose up -d ssrf_proxy` 重建。foundry 走公网域名时不需要这条。

### 3. 添加两个 MCP server（Integrations → Tools → MCP）

| 字段 | 员工 | HR |
|---|---|---|
| Server URL | `http://host.docker.internal:3100/mcp` | `http://host.docker.internal:3100/mcp?as=hr_admin` |
| Server Identifier | `foundry-employee` | `foundry-hr-admin` |
| Use Dynamic Client Registration | **关**（foundry 不做 OAuth） | 关 |
| Headers | `Authorization: Bearer <employee 令牌>` | `Authorization: Bearer <hr_admin 令牌>` |

两个注意点：

- Dify 按 server URL 哈希查重，同一地址不能挂两次——第二个加个无害的查询参数
  区分（foundry 只按 pathname 路由，query 被忽略）。
- 保存后列表应立即显示 Authorized + 工具数（employee 3 个 / hr_admin 4 个）。
  若显示 "Authorization is required"，先查第 2 步的代理放行，再查 header 是否
  真的存上了（见下面坑 2）。

### 4. 建两个 Agent 应用

Studio 建 Agent 应用（或 DSL 导入），各自挂对应 MCP server 的全部工具，
模型任选支持 function calling 的（实测 glm-4.6）。系统提示词参考
`packages/feishu/src/agent.ts` 的 `buildSystemPrompt`——核心是「refusal 是
权限系统的最终裁决，如实转述、不绕行、不替用户猜数据」。发布后每个应用
自带公开访问链接，免登录可玩。

## 踩坑记录（VPS 部署会原样再遇到）

1. **SSRF 代理 403**：见步骤 2。定位方式：`docker logs docker-ssrf_proxy-1`
   里的 `TCP_DENIED/403`。
2. **Header 值静默丢失**：Dify 的 header 值输入框在某些输入方式下（实测为
   浏览器自动化的直接赋值）不进 React 状态，存库变成空字符串——服务端视同
   没带 header → 401 → Dify 转而尝试 OAuth 发现 → 报 "Failed to discover
   OAuth metadata"。手工键盘输入正常。定位方式：对比 401 响应体积
   （foundry 对"缺 header"和"坏令牌"的提示语长度不同）。
3. **同 URL 查重**：见步骤 3 的 query 参数技巧。
4. **Docker 虚拟磁盘**：Dify 全家桶镜像 10GB 级，虚拟磁盘小于 30GB 会在
   dify-api 解压时报 no space left on device。
5. **端口冲突**：Dify nginx 默认 80，本地开发注意 `EXPOSE_NGINX_PORT`。

## VPS 部署方案（待执行）

推荐形态：**foundry 独立子域名，Dify 用公网地址接**——与 trpg 同模式，
以后 Coze / n8n / 任意 MCP host 接入都是同一个地址，且不碰 SSRF 白名单。

```
foundry.yiongspace.com  → Caddy 反代 → foundry-server :3100（token 模式）
dify.yiongspace.com     → Caddy 反代 → Dify nginx :8093（公开 app 链接从这走）
```

Caddyfile 追加：

```caddy
foundry.yiongspace.com {
    reverse_proxy 127.0.0.1:3100
}
dify.yiongspace.com {
    reverse_proxy 127.0.0.1:8093
}
```

要点：

- foundry 生产必须 token 模式（设 `FOUNDRY_IDENTITY_SECRET`），密钥与本地演示不同；
  公网上跑 headers 模式等于裸奔。
- Dify `docker/.env`：`EXPOSE_NGINX_PORT=8093`、`SECRET_KEY` 用
  `openssl rand -base64 42` 生成、`CONSOLE_API_URL`/`APP_WEB_URL` 设为
  `https://dify.yiongspace.com`。
- Dify 里 MCP server URL 用 `https://foundry.yiongspace.com/mcp`，不再需要
  SSRF 白名单。
- 令牌过期演示会断——demo 令牌给足 TTL，或到期用 mint-token 重签、在 Dify
  的 MCP server 编辑页更新 header。
