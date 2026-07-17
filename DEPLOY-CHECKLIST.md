# 上线操作清单（VPS · 逐条照敲）

> 拓扑与 ai-edge 同构：**服务只绑 loopback，Caddy 在最前做 HTTPS**。
> foundry 比 ai-edge 简单得多——单进程、无模型下载、无 submodule。
> 占位符：`foundry.yiongspace.com` = 网关域名；`dify.yiongspace.com` = Dify 控制台。

```
浏览器 / Dify / 任意 MCP host
   │  https
   ▼
foundry.yiongspace.com ──► Caddy :443 ──► 127.0.0.1:3100  foundry-server（token 模式）
dify.yiongspace.com    ──► Caddy :443 ──► 127.0.0.1:8093  Dify nginx（自托管入口层）
```

## 0. 前置

- [ ] DNS：`foundry` 与 `dify` 两条 A 记录 → VPS 公网 IP（与 `api`/`trpg` 同 IP）
- [ ] VPS 已有 Docker + Caddy（跑着 ai-edge / trpg 即已具备）
- [ ] 内存余量 ≥ 4GB（Dify 自托管 14 个容器，约占 3–4GB；`free -h` 看 available）

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

```bash
docker compose up --build -d
docker compose logs foundry-server | tail -3   # 应见 "identity: signed token"
```

若日志出现 `identity: DEMO trust headers … unsigned, anyone can claim any role`
→ 密钥没注进去，**立刻停下排查**，别接 Caddy。

## 4. 冒烟（先本机，再公网）

```bash
set -a; . ./.env; set +a
BASE=http://127.0.0.1:3100 bash smoke.sh
```

五针全绿才继续：healthz 200 / 伪造头 401 / employee 3 工具无 get_salary /
hr_admin 4 工具含 get_salary / 篡改签名 401。

## 5. Caddy（两个站点，各两行）

```bash
cat >>/etc/caddy/Caddyfile <<'EOF'

foundry.yiongspace.com {
    reverse_proxy 127.0.0.1:3100
}

dify.yiongspace.com {
    reverse_proxy 127.0.0.1:8093
}
EOF
systemctl reload caddy
BASE=https://foundry.yiongspace.com bash smoke.sh   # 公网版，仍需五针全绿
```

Caddy 自动签发/续期证书。

## 6. 签发长效演示令牌

```bash
docker compose exec -e FOUNDRY_IDENTITY_SECRET="$FOUNDRY_IDENTITY_SECRET" foundry-server \
  pnpm --filter @yiong/foundry-server run mint-token --user e002 --role employee --ttl 31536000
docker compose exec -e FOUNDRY_IDENTITY_SECRET="$FOUNDRY_IDENTITY_SECRET" foundry-server \
  pnpm --filter @yiong/foundry-server run mint-token --user e004 --role hr_admin --ttl 31536000
```

演示令牌给足 TTL（一年），否则某天 demo 会静默失效。到期用同样命令重签、
在 Dify 的 MCP server 编辑页更新 header。

## 7. Dify 自托管

```bash
cd /opt && git clone --depth 1 https://github.com/langgenius/dify.git && cd dify/docker
cp .env.example .env
sed -i "s|^EXPOSE_NGINX_PORT=.*|EXPOSE_NGINX_PORT=8093|" .env
sed -i "s|^EXPOSE_NGINX_SSL_PORT=.*|EXPOSE_NGINX_SSL_PORT=8443|" .env   # 默认 443 会撞 Caddy
sed -i "s|^SECRET_KEY=.*|SECRET_KEY=$(openssl rand -base64 42)|" .env
sed -i "s|^CONSOLE_API_URL=.*|CONSOLE_API_URL=https://dify.yiongspace.com|" .env
sed -i "s|^CONSOLE_WEB_URL=.*|CONSOLE_WEB_URL=https://dify.yiongspace.com|" .env
sed -i "s|^SERVICE_API_URL=.*|SERVICE_API_URL=https://dify.yiongspace.com|" .env
sed -i "s|^APP_API_URL=.*|APP_API_URL=https://dify.yiongspace.com|" .env
sed -i "s|^APP_WEB_URL=.*|APP_WEB_URL=https://dify.yiongspace.com|" .env
```

Dify 的 nginx 默认把端口发布到 `0.0.0.0`——等于在公网裸奔一个 HTTP 控制台、
绕过 Caddy 的 HTTPS。加 override 收到 loopback（与 foundry 同一姿态）：

```bash
cat > docker-compose.override.yml <<'EOF'
services:
  nginx:
    ports: !override
      - "127.0.0.1:8093:80"
EOF
docker compose config | grep -A2 'target: 80'   # 应见 host_ip: 127.0.0.1
docker compose up -d                            # 首次拉 ~10GB 镜像，耐心等
```

foundry 走公网域名接入，**不需要** `SSRF_PROXY_ALLOW_PRIVATE_DOMAINS`
（那条只在 Dify 直连宿主机私网地址时才需要，见 [docs/dify-integration.md](docs/dify-integration.md)）。

## 8. 配置 Dify

浏览器开 `https://dify.yiongspace.com/install` 建管理员，然后照
[docs/dify-integration.md](docs/dify-integration.md) 步骤 3–4：

- 装 ZHIPU AI 模型插件、填 GLM key
- 加两个 MCP server（URL 都是 `https://foundry.yiongspace.com/mcp`，
  第二个加 `?as=hr_admin` 绕开 Dify 的 URL 查重），header 各填对应长效令牌
- 建两个 Agent 应用，验收：employee 3 工具 / hr_admin 4 工具，同问不同答

## 9. 端口暴露复核（别信 compose 写了什么，去打一下）

```bash
# 从本机（不是服务器上）打裸端口——必须连不上
curl -m 8 --noproxy '*' http://<VPS_IP>:3100/healthz    # 期望：连接失败
curl -m 8 --noproxy '*' http://<VPS_IP>:8093/           # 期望：连接失败
curl -m 8 --noproxy '*' https://foundry.yiongspace.com/healthz   # 期望：200
```

`--noproxy '*'` 不能省：本机若挂着代理，代理连不上源站会回 **502**，看起来
像"服务器拒绝了"，其实什么都没验到（这个假阳性实测踩过）。服务器侧对照：
`ss -tlnp | grep -E ':3100|:8093'` 应当只见 `127.0.0.1:`，不能有 `0.0.0.0:`。

## 10. 收尾

- [ ] README 诚实边界更新：公网演示地址、令牌到期口径
- [ ] 审计卷备份策略（`foundry-audit` 卷，可选）
- [ ] 演示数据仍是 6 人 fixture——对外说明这是演示口径，非生产数字

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

# ⑤ 签两枚一年期令牌（本机私钥），更新 Dify 两个 MCP server 的 Authorization header
pnpm --filter @yiong/foundry-server run mint-token \
  --key ~/.config/mcp-foundry/identity-es256.key --kid 2026-07-vps \
  --user e002 --role employee --ttl 31536000
pnpm --filter @yiong/foundry-server run mint-token \
  --key ~/.config/mcp-foundry/identity-es256.key --kid 2026-07-vps \
  --user e004 --role hr_admin --ttl 31536000
```

Dify 侧坑：MCP server 的 header value 是 masked 受控输入，直接粘贴不一定触发保存
（存进去仍是旧值 → 握手 401 → 报 "Failed to discover OAuth metadata"）。稳妥做法是
删掉旧 header 行、Add Header 重填；保存后点 Update 重拉工具面，无 OAuth 报错即成功。
端到端验收：两个体验链接各问一句「张三的工资是多少」，employee 结构化拒答、
hr_admin 返回真数字（18500 CNY）。

**轮换/换密钥**：再跑 keygen 换新 kid → 把新 JWK 追加进 `/opt/foundry-keys/jwks.json`
的 keys（新旧并存过渡，Foundry 按 mtime... 实为 URL 轮询热更新，≤ 刷新间隔生效）→
用新私钥重签令牌、更新 Dify header → 过渡期结束删旧 JWK 即吊销旧 kid。私钥落盘 0600、
`.key/.pem` 已被 .gitignore；令牌明文只存本机 `~/.config/mcp-foundry/`（600），不进仓库。

## 12. 落地页（根路径 GET 给人看，/mcp 仍只给机器）

`landing/index.html` 是自包含静态页（无外部依赖），rsync 会随代码一起上去
（§1 的排除项不匹配它）。改动只在 Caddy：把 foundry 站点的兜底 handle 从
「反代一切」改成 file_server，**同时给 /mcp 和 /healthz 显式保留反代**
（smoke.sh 两个都要打；handle 按路径最长前缀优先，顺序无所谓但都得在）：

```bash
# Caddyfile 的 foundry 块改成（/jwks.json 块保持原样不动）：
#   foundry.yiongspace.com {
#       handle /jwks.json { root * /opt/foundry-keys; file_server }
#       handle /mcp*      { reverse_proxy 127.0.0.1:3100 }
#       handle /healthz   { reverse_proxy 127.0.0.1:3100 }
#       handle            { root * /opt/mcp-foundry/landing; file_server }
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
