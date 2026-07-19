# 上线操作清单（VPS · 逐条照敲）

> 拓扑与 ai-edge 同构：**服务只绑 loopback，Caddy 在最前做 HTTPS**。
> 占位符：`foundry.yiongspace.com` = 网关域名；`crm.yiongspace.com` = LangGraph 对话前端；
> `twenty.yiongspace.com` = 自托管 Twenty CRM 后台。

```
浏览器 / LangGraph / 任意 MCP host
   │  https
   ▼
foundry.yiongspace.com ──► Caddy :443 ──► 127.0.0.1:3100  foundry-server（网关，token 模式）
crm.yiongspace.com     ──► Caddy :443 ──► 127.0.0.1:8100  LangGraph 前端（FastAPI + SSE）
twenty.yiongspace.com  ──► Caddy :443 ──► 127.0.0.1:3200  Twenty CRM（自托管真库）
```

网关容器经 `host.docker.internal:host-gateway` 访问宿主机发布的 Twenty
（`TWENTY_API_URL=http://host.docker.internal:3200`）；LangGraph 容器 `network_mode: host`
直连 `127.0.0.1:3100` 的网关 `/mcp`。

## 0. 前置

- [ ] DNS：`foundry` / `crm` / `twenty` 三条 A 记录 → VPS 公网 IP（与 `api`/`trpg` 同 IP）
- [ ] VPS 已有 Docker + Caddy（跑着 ai-edge / trpg 即已具备）
- [ ] 内存余量 ≥ 4GB（Twenty 全家桶 postgres/redis/server/worker 约占 2.5–3GB；`free -h` 看 available）

## 1. 上传代码

仓库是私有的、服务器上没有 GitHub 凭据（ai-edge 当初也是拷上去的，`/opt/ai-edge`
里没有 `.git`）。从**本机**推：

```bash
rsync -az --delete \
  --exclude node_modules --exclude .git --exclude .env \
  --exclude 'audit/*.jsonl' --exclude eval-reports \
  --exclude config/identity.feishu.yaml \
  ./ root@<VPS_IP>:/opt/mcp-foundry/
```

排除项里 `.env` 与 `identity.feishu.yaml` 是硬要求——它们含密钥/真实 open_id，
绝不上传（服务器上的 `.env` 由下一步现场生成）。

## 2. 生产密钥（唯一要动脑的一步）

```bash
cp .env.production.example .env
sed -i "s|^FOUNDRY_IDENTITY_SECRET=.*|FOUNDRY_IDENTITY_SECRET=$(openssl rand -base64 42)|" .env
```

`.env` 只存在于服务器（已被 .gitignore 忽略）。**生产密钥必须与本地演示密钥不同**；
公网上跑 demo 头模式等于裸奔——第 4 步的冒烟会当场揪出这种错误部署。

## 3. 起服务（无模型下载，秒级）

两种方式任选（compose 里 `image:` 指 GHCR、`build:` 作兜底，两条都支持）：

**A. 按摘要拉取（推荐 —— 部署物 = CI 测过的那一版）**

```bash
# 一次性：登录 GHCR 才能拉镜像（PAT 需 read:packages；把 GHCR 包设为 public 则免登录）
echo "$GHCR_PAT" | docker login ghcr.io -u yiongq --password-stdin

docker compose pull            # 拉 latest（= 最新 main，CI push 时已构建）
docker compose up -d           # 起来，不本地构建
```

**B. 本机现建（离线 / 不想接 GHCR 时的兜底，即老流程）**

```bash
docker compose up --build -d
```

任一方式之后：

```bash
docker compose logs foundry-server | tail -3   # 应见 "identity: signed token"
```

**回滚 / 钉某一版**：`FOUNDRY_IMAGE_TAG=<git-sha> docker compose up -d`
（sha 见 GitHub Actions 或 `git log`；缺省 `latest`）。LangGraph 前端（§8）同样支持 A/B 两条。

若日志出现 `identity: DEMO trust headers … unsigned, anyone can claim any role`
→ 密钥没注进去，**立刻停下排查**，别接 Caddy。（新版默认 fail-closed：缺签名身份且未设
`FOUNDRY_DEMO=1` 时进程直接拒绝启动，compose 的 `:?` 再兜一道。）

> **非 root 迁移（一次性）**：镜像现以非 root（uid 10001）运行。若 `foundry-audit` 卷是早先
> root 属主建的，新容器写审计会 `EACCES`。首次升级后 chown 一次：
> `docker run --rm -v mcp-foundry_foundry-audit:/audit alpine chown -R 10001:10001 /audit`
>
> 就绪/指标探针：`/readyz`（查 JWKS 可用，fail-closed 时 503）、`/metrics`（Prometheus）。

## 4. 冒烟（先本机，再公网）

```bash
set -a; . ./.env; set +a
BASE=http://127.0.0.1:3100 bash smoke.sh
```

五针全绿才继续：healthz 200 / 伪造头 401 / employee 3 工具无 get_salary /
hr_admin 4 工具含 get_salary / 篡改签名 401。

## 5. Caddy（三个站点）

反代配置现纳入版本控制：[`config/Caddyfile`](config/Caddyfile)（含安全响应头、请求体上限、
可选边缘限流）。别再手写 `/etc/caddy/Caddyfile`——从仓库 import，改配置走 PR：

```bash
# 主 Caddyfile import 仓库版（部署目录假设 /opt/mcp-foundry）
grep -q 'import /opt/mcp-foundry/config/Caddyfile' /etc/caddy/Caddyfile \
  || echo 'import /opt/mcp-foundry/config/Caddyfile' >>/etc/caddy/Caddyfile
systemctl reload caddy
BASE=https://foundry.yiongspace.com bash smoke.sh   # 公网版，仍需五针全绿
```

> 边缘限流用 `caddy-ratelimit` 插件（stock Caddy 不含）——见 `config/Caddyfile` 顶部 xcaddy
> 构建说明。未装插件时删掉 `rate_limit` 块即可正常起（安全头/请求体上限照常生效）。

Caddy 自动签发/续期证书。

## 6. 签发长效演示令牌

```bash
docker compose exec -e FOUNDRY_IDENTITY_SECRET="$FOUNDRY_IDENTITY_SECRET" foundry-server \
  pnpm --filter @yiong/foundry-server run mint-token --user e002 --role employee --ttl 31536000
docker compose exec -e FOUNDRY_IDENTITY_SECRET="$FOUNDRY_IDENTITY_SECRET" foundry-server \
  pnpm --filter @yiong/foundry-server run mint-token --user e004 --role hr_admin --ttl 31536000
```

演示令牌给足 TTL（一年），否则某天 demo 会静默失效。到期用同样命令重签、
更新 LangGraph 客户端 `.env` 的 `FOUNDRY_MCP_TOKEN` 后重建容器。

## 7. Twenty CRM 自托管（真库后端）

Twenty 官方 docker compose：postgres + redis + server + worker。端口只发布到 loopback，
Caddy 在最前做 HTTPS（与 foundry 同姿态）。

```bash
cd /opt && git clone --depth 1 https://github.com/twentyhq/twenty.git && cd twenty
cp packages/twenty-docker/.env.example .env
# 关键 env（否则启动校验失败/crash-loop）：
#   STORAGE_TYPE=local        （留空会 config 校验失败）
#   APP_SECRET / PG 密码       （openssl rand 生成）
#   SERVER_URL=https://twenty.yiongspace.com
# 端口收到 loopback：server 服务 ports 映射改成 127.0.0.1:3200:3000
docker compose up -d
docker compose logs server | tail -5   # 等 migration 跑完、健康
```

浏览器开 `https://twenty.yiongspace.com` 建工作区管理员，然后：

- Settings → API & Webhooks 生成 API key（记到本机 `~/.config/mcp-foundry/twenty-api-key.txt`，600）
- 给 People / Companies / Opportunities（以及退款的 Order/Refund 自定义对象）建归属自定义
  字段 `repCode`（TEXT，值=令牌 userId 如 e007；不用内建 accountOwnerId——它是 workspaceMember
  UUID，与员工号口径对不上，见 docs/twenty-notes.md），
  否则 `owner_id` 归属为空、行级过滤会「宁可错拒」（见 [docs/twenty-notes.md](docs/twenty-notes.md)）
- 灌入演示数据（5 客户 / 5 联系人 / 5 商机 / 3 个销售身份的 owner 分布）

网关 `.env` 接真库（设了即从 fixture 切 REST，写通道随之开）：

```bash
# /opt/mcp-foundry/.env
TWENTY_API_URL=http://host.docker.internal:3200
TWENTY_API_KEY=<上面的 API key>
TWENTY_OWNER_FIELD=repCode
docker compose up -d --force-recreate   # restart 不重载 .env，必须 force-recreate
docker compose logs foundry-server | tail -3   # 应见 "crm backend: twenty（REST 真库）"
```

## 8. 部署 LangGraph 对话前端

自建 Python 客户端（`clients/langgraph`，`langchain-mcp-adapters` 直连网关 /mcp +
FastAPI SSE 流式前端）随 §1 rsync 一起上去。容器 `network_mode: host`、`env_file: .env`：

```bash
cd /opt/mcp-foundry/clients/langgraph
cp .env.example .env
# 填：FOUNDRY_MCP_URL=http://127.0.0.1:3100/mcp
#     FOUNDRY_MCP_TOKEN=<§6 或 §11 签的长效令牌，决定这个前端以谁的身份连网关>
#     FOUNDRY_LLM_BASE_URL / _API_KEY / _MODEL（OpenAI 兼容，如智谱 glm-4.6）
docker compose up --build -d
docker compose logs -f --tail 5   # 应见 uvicorn 起在 :8100
```

验收：浏览器开 `https://crm.yiongspace.com`，问「我的商机有哪些」出真 Twenty 数据；
越权问同事的商机被 row_denied 并如实转述「已记入审计」；涉审写触发审批卡片（§13）。

## 9. 端口暴露复核（别信 compose 写了什么，去打一下）

```bash
# 从本机（不是服务器上）打裸端口——必须连不上
curl -m 8 --noproxy '*' http://<VPS_IP>:3100/healthz    # 期望：连接失败
curl -m 8 --noproxy '*' http://<VPS_IP>:8100/           # 期望：连接失败（LangGraph）
curl -m 8 --noproxy '*' http://<VPS_IP>:3200/           # 期望：连接失败（Twenty）
curl -m 8 --noproxy '*' https://foundry.yiongspace.com/healthz   # 期望：200
```

`--noproxy '*'` 不能省：本机若挂着代理，代理连不上源站会回 **502**，看起来
像"服务器拒绝了"，其实什么都没验到（这个假阳性实测踩过）。服务器侧对照：
`ss -tlnp | grep -E ':3100|:8100|:3200'` 应当只见 `127.0.0.1:`，不能有 `0.0.0.0:`。

## 10. 收尾

- [ ] README 诚实边界更新：公网演示地址、令牌到期口径
- [ ] 审计 + Twenty 备份入 cron 每日：`BACKUP_DIR=/opt/foundry-backups OFFSITE_RCLONE_REMOTE=… bash scripts/backup.sh`（[scripts/backup.sh](scripts/backup.sh)）。防篡改 ≠ 不丢，异地副本必备
- [ ] 数据口径：HR 域仍是 6 人 fixture；CRM 域是真实 Twenty（演示口径，非生产规模）

## 11. 切换到 JWKS / 轮换演示令牌（W7，已实操）

线上从 HS256 切到非对称 JWKS URL 模式：签发私钥只在管理员本机，服务器只见公钥集。
令牌换成 ES256 后旧 HS256 令牌即时作废。**零中断顺序**（先备份 Caddyfile）：

```bash
# ① 本机生成密钥对（私钥留本机、绝不上服务器；公钥 JWKS 待会儿上）
mkdir -p ~/.config/mcp-foundry
pnpm --filter @yiong/foundry-server run keygen --kid 2026-07-vps \
  --out ~/.config/mcp-foundry/identity-es256.key \
  --jwks-out ~/.config/mcp-foundry/jwks.json

# ② 公钥集上服务器，Caddy 在 foundry 站点里静态供给 /jwks.json（与 /mcp 反代分流）
ssh root@<VPS_IP> 'mkdir -p /opt/foundry-keys'
scp ~/.config/mcp-foundry/jwks.json root@<VPS_IP>:/opt/foundry-keys/jwks.json
# Caddyfile 的 foundry 块改成：
#   foundry.yiongspace.com {
#       handle /jwks.json { root * /opt/foundry-keys; file_server }
#       handle { reverse_proxy 127.0.0.1:3100 }
#   }
# caddy validate && systemctl reload caddy
curl -s https://foundry.yiongspace.com/jwks.json | head -3   # 公网可取

# ③ 服务器 .env 加 URL，重建容器（compose 已透传该 env）
#   FOUNDRY_IDENTITY_JWKS=https://foundry.yiongspace.com/jwks.json
# docker compose up -d ；日志应见 "signed token via JWKS URL"
# 容器内 hairpin 自测：fetch 该 URL 应 200（Caddy 回环可达）

# ④ 冒烟：ES256 探针（本机私钥现签），并确认旧 HS256 令牌已 401
BASE=https://foundry.yiongspace.com \
FOUNDRY_IDENTITY_KEY=~/.config/mcp-foundry/identity-es256.key \
FOUNDRY_IDENTITY_KID=2026-07-vps bash smoke.sh   # 五针全绿

# ⑤ 签长效令牌（本机私钥）。线上 CRM 前端以 **sales_rep（e007）** 身份连网关——
#   千万别用 sales_manager，它 approver 且免审，会静默关掉高危写审批（HITL 演不出来）。
pnpm --filter @yiong/foundry-server run mint-token \
  --key ~/.config/mcp-foundry/identity-es256.key --kid 2026-07-vps \
  --user e007 --role sales_rep --ttl 31536000
```

更新客户端令牌：把 rep 令牌写进 `/opt/mcp-foundry/clients/langgraph/.env` 的
`FOUNDRY_MCP_TOKEN`，`docker compose up -d --force-recreate`（restart 不重载 .env）。
**审批人令牌不放前端**：共享公网页面不配 `FOUNDRY_MCP_APPROVER_TOKEN`（否则任何访客
可自批高危写——见职责分离纪律）；审批只走飞书那条独立认证的路。
端到端验收：`https://crm.yiongspace.com` 以 rep 身份问「我名下有哪些客户」只见自己的 3 家、
跨域问工资零泄漏、越权查同事商机被 row_denied、退款超额被挂起等飞书批复。

**轮换/换密钥**：再跑 keygen 换新 kid → 把新 JWK 追加进 `/opt/foundry-keys/jwks.json`
的 keys（新旧并存过渡，Foundry 按 URL 轮询热更新，≤ 刷新间隔生效）→ 用新私钥重签令牌、
更新 LangGraph 客户端 .env → 过渡期结束删旧 JWK 即吊销旧 kid。私钥落盘 0600、
`.key/.pem` 已被 .gitignore；令牌明文只存本机 `~/.config/mcp-foundry/`（600），不进仓库。

## 12. 落地页（根路径 GET 给人看，/mcp 仍只给机器）

`landing/index.html` 是自包含静态页（无外部依赖），rsync 会随代码一起上去
（§1 的排除项不匹配它）。改动只在 Caddy：把 foundry 站点的兜底 handle 从
「反代一切」改成 file_server，**同时给 /mcp 和 /healthz 显式保留反代**
（smoke.sh 两个都要打；handle 按路径最长前缀优先，顺序无所谓但都得在）：

```bash
# Caddyfile 的 foundry 块改成（/jwks.json 块保持原样不动）：
#   foundry.yiongspace.com {
#       handle /jwks.json   { root * /opt/foundry-keys; file_server }
#       handle /mcp*        { reverse_proxy 127.0.0.1:3100 }
#       handle /healthz     { reverse_proxy 127.0.0.1:3100 }
#       handle /approvals*  { reverse_proxy 127.0.0.1:3100 }   # W9 审批决策端点，缺了会被 file_server 兜走
#       handle              { root * /opt/mcp-foundry/landing; file_server }
#   }
caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy

# 验收三针：
curl -s https://foundry.yiongspace.com/ | grep -q '同一个网关' && echo landing-ok
curl -s https://foundry.yiongspace.com/jwks.json | head -1     # 公钥集仍公网可取
BASE=https://foundry.yiongspace.com \
FOUNDRY_IDENTITY_KEY=~/.config/mcp-foundry/identity-es256.key \
FOUNDRY_IDENTITY_KID=2026-07-vps bash smoke.sh                 # 五针仍全绿
```

改完后浏览器打开 `foundry.yiongspace.com` 是产品落地页，不再是
`only POST /mcp is served` 的 JSON-RPC 报错；`POST /mcp` 行为不变。

## 13. 审批闸门（W9：涉审写工具 + /approvals 决策端点）

代码随 rsync + rebuild 自动生效，无独立开关——闸门由 `config/rbac.twenty.yaml`
的 `approval:` 列表驱动（sales_rep 的 update/delete_contact、update_opportunity_stage
涉审；create_contact 免审；sales_manager 免审且 `approver: true`）。单据落
`/app/audit/approvals.jsonl`（与审计同卷，已被 §1 的 `audit/*.jsonl` 排除项覆盖，
不会被 rsync 冲掉）。Caddy 需加 §12 里的 `/approvals*` 反代行。

```bash
# 验收（fixture 后端即可验，不需要真库/REST）：
# ① 以 sales_rep 令牌调 delete_contact → kind=pending，拿到 approvalId
# ② 以 sales_manager 令牌看单：
curl -s https://foundry.yiongspace.com/approvals -H "Authorization: Bearer $MANAGER_TOKEN"
# ③ 批准：
curl -s -X POST https://foundry.yiongspace.com/approvals/<id> \
  -H "Authorization: Bearer $MANAGER_TOKEN" -H 'content-type: application/json' \
  -d '{"decision":"approve"}'
# ④ 同一身份同参重试 ① → kind=ok（消票执行）；再试一次 → 新的 pending（票不复用）
```

飞书侧（独立进程，单据文件独立 `audit/approvals.feishu.jsonl`）：控制台
「事件与回调」把 `card.action.trigger` 回调订阅为**使用长连接接收**即可，
无需公网 URL；可选 `FEISHU_APPROVAL_CHAT_ID` 指定审批卡片投递会话（缺省发到
触发对话本身）。真库写通道：网关 `.env` 设 `TWENTY_API_URL` + `TWENTY_API_KEY`（§7）
即从 fixture 切 Twenty REST，审批通过后的写落到真实 Twenty；不设时走 fixture。

## 14. 防篡改审计（可选，签名哈希链）

审计日志默认是明文 JSONL。设 `FOUNDRY_AUDIT_SIGNING_KEY` 即升级为 Ed25519 签名哈希链：
每条记录带 `seq`/`prevHash`/`hash`/`sig`，改一条断整链、伪造验签不过，校验只需公钥、
可离线复核。私钥属签发方（管理员本机）、绝不落服务器——与 JWKS 身份同一条纪律。

```bash
# ① 本机生成审计密钥对（私钥留本机 0600、绝不上服务器；公钥随日志分发给校验方）
pnpm --filter @yiong/foundry-server run audit-keygen \
  --out ~/.config/mcp-foundry/audit-ed25519.key \
  --pub-out ~/.config/mcp-foundry/audit-ed25519.pub

# ② 私钥上服务器（0600），.env 指到它，重建容器
scp ~/.config/mcp-foundry/audit-ed25519.key root@<VPS_IP>:/opt/foundry-keys/
#   .env: FOUNDRY_AUDIT_SIGNING_KEY=/opt/foundry-keys/audit-ed25519.key
# docker compose up -d --force-recreate ；日志应见 "audit: Ed25519 签名哈希链（防篡改）"

# ③ 校验（把日志拷回本机或在服务器上跑，只需公钥——校验方不碰私钥）
pnpm --filter @yiong/foundry-server run verify-audit \
  --file audit/foundry.jsonl --pubkey ~/.config/mcp-foundry/audit-ed25519.pub
# 链完整 → "✓ 审计链完整：N 条记录…全部 Ed25519 验签通过" + 打印末条 hash、exit 0
# 任一处被动过（改字段/删中间/重排/伪造）→ "✗ 审计链断裂 @ seq K：…"、exit 1
```

边界（诚实）：签名哈希链抓得住**篡改、插入、重排、删中间**（seq 跳号或 prevHash 断链），
但**抓不住尾部截断**——删掉最近 K 条会留下一段更短却自洽的合法链。缓解：把 verify 打印的
「末条 hash + 条数」定期外部锚定（另一处 append-only sink / 见证服务），校验时传
`--expect-last <锚定值>`，末条对不上即判尾部截断。另：签名只保证「记下的没被动过」，不保证
「所有该记的都记了」（进程在 `appendFile` 之前被杀的那条不落盘——链仍自洽，只是少一条）。
私钥属签发方、`.key/.pem` 已被 .gitignore。
