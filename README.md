# mcp-foundry（工作名）

> Guarded MCP gateway for internal business systems — role-scoped tools, row/field-level data
> guards, human-in-the-loop approvals, and a per-call audit trail.

把内部系统（先做 HR，现已加上 CRM 演示域）接到 MCP 上，并在协议层前面加一道守卫：
谁、能用哪些工具、能看到哪些行哪些字段，高危写操作先过人的点头，问过什么都有账可查。

**线上可体验**（免注册，两个链接问同一句「张三的工资是多少」）：
[员工视角](https://dify.yiongspace.com/chat/kg6XFb18BoBfzHj2)结构化拒答 ·
[HR 视角](https://dify.yiongspace.com/chat/CP3QrYkheA2Zz6P5)返回真实数字。
两个应用连的是**同一个网关地址**（`https://foundry.yiongspace.com/mcp`），只有身份令牌不同——
员工那个的工具面里根本没有 `get_salary`，不是模型忍住不说。

## 为什么做：三个事故 → 三个能力

给 Agent 接内部系统，出的事基本是三类：普通员工顺嘴一问就拿到了同事的工资（没有行级边界）；
模型"好心"把带手机号、薪资的整行数据吐进回答（没有字段脱敏）；出事之后翻不出谁在什么时候问过什么
（没有审计）。对应地，Foundry 只做三件事：**角色 → 工具白名单**——不该用的工具连 tools/list
都不出现，而不是调用被拒之后再解释；**行级过滤 + 字段脱敏**——结构化规则在守卫出口强制执行，
不靠提示词自觉；**每次调用一条审计流水**——只记参数哈希不记原文，审计日志本身不成为第二个泄漏面。
拒答是结构化分支，结构上不可能夹带业务数据。

CRM 域开放写工具后补上第四道：**高危写操作人工审批（Human-in-the-Loop）**——
涉审工具的调用在执行前被闸门挂起成审批单（`kind: pending`，与拒答同款结构化分支、
无 data 字段），审批人在飞书卡片一键批复或走 `POST /approvals/{id}`；批准后同一
调用重试即消票执行（一单一次，防重放），飞书入口还会自动续跑并把结果推回原对话。
闸门在守卫管线内、`adapter.execute` 之前——行级过滤拦得住泄漏但拦不住已发生的写入，
审批必须在写入发生前。哪些工具涉审由 `rbac.*.yaml` 的 `approval:` 列表按角色声明
（销售代表改/删要审、新建免审、经理免审），审批权由 `approver: true` 标记。

## 架构

```
入口层（二选一，身份都透传给同一套守卫）
  ├─ MCP 客户端（Claude Code / Dify / 任意 Streamable HTTP host）
  │    POST /mcp，身份：Bearer 签名令牌（生产）或 x-foundry-* 头（demo）
  │    → packages/server（@yiong/foundry-server，无状态）
  └─ 飞书 bot（packages/feishu，长连接，无需公网回调）
       sender open_id → config/identity.feishu.yaml 映射 → principal
       → GLM tool-calling 循环（自然语言进、按身份收窄的工具面出）
        ▼
┌────────────────────────────────────────────┐     config/rbac.*.yaml
│ packages/core  Guard 管线                   │◀────（角色→工具 / 审批名单 / 行规则 / 脱敏字段）
│ 角色查找 → 工具白名单 → 审批闸门（写前挂起）   │
│ → 行级过滤 → 字段脱敏                        │
│ → 审计 JSONL + 审批单 JSONL（audit/）        │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│ SystemAdapter：orangehrm（HR）              │    ERP …（路线图，今天没有）
│   fixture / 只读 MySQL（真实 OrangeHRM 5.7） │
│              ：espocrm（CRM）                │
│   fixture / 只读 MySQL（真实 EspoCRM 9.3）   │
│              ：memory（跨会话记忆，域内 RBAC）│
└────────────────────────────────────────────┘
```

飞书入口的关键：**安全不靠提示词**。工具面在 LLM 看到之前就按身份收窄（员工的工具
定义里根本没有 get_salary），越权数据在守卫出口就不存在（refusal 分支无 data 字段），
模型想编也没材料。同一个人在飞书里换身份问同一句「张三的工资是多少」——员工被结构化
拒答、HR 返回真实数字，全程留审计。搭建见 [packages/feishu](packages/feishu)。

配套：`packages/eval` 是越权/泄漏评测——86 题跨三个域（HR 29 + 记忆 20 + CRM 37，
含跨会话记忆泄露与跨域越权）、硬断言 + LLM-judge 双轨（judge 须先过人工校准）、
3 次重复报方差、守卫逐层开/关 ablation 曲线。CI 的 eval-gate 在 fixture 上跑并上传
报告；方法与实测数据见 [docs/eval-methodology.md](docs/eval-methodology.md)。

## Quickstart（fixture 模式，无需任何密钥）

```bash
pnpm install
pnpm --filter @yiong/foundry-server serve   # → http://localhost:3100/mcp
```

换不同身份问同一个问题，行为不同（这正是卖点）：

```bash
# 小王（employee）：tools/list 里根本看不到 get_salary
curl -s http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-foundry-user: e002' -H 'x-foundry-role: employee' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

# 小王查别人的假期 → 结构化拒答 row_denied（不是模型忍住不说，是数据没进上下文）
curl -s http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-foundry-user: e002' -H 'x-foundry-role: employee' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_leave_balance","arguments":{"employee_id":"e001"}}}'

# 老李（hr_admin）查薪资 → 正常返回
curl -s http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-foundry-user: e004' -H 'x-foundry-role: hr_admin' \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_salary","arguments":{"employee_id":"e001"}}}'

# 上面每一次调用都留了一条审计
tail -3 audit/foundry.jsonl
```

同一个网关还挂着第二个业务域（CRM，EspoCRM 形状的 fixture）。角色按域独立：
销售看不到全员业绩盘，HR 的通配权力跨不进 CRM——

```bash
# 孙七（sales_rep）想看全员业绩盘 → 白名单拒绝（这工具在他的 tools/list 里根本不出现）
curl -s http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-foundry-user: e007' -H 'x-foundry-role: sales_rep' \
  -d '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_pipeline_summary","arguments":{}}}'

# 王五（sales_manager）看业绩盘 → 正常返回
curl -s http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-foundry-user: e005' -H 'x-foundry-role: sales_manager' \
  -d '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"get_pipeline_summary","arguments":{}}}'

# 老李（hr_admin，HR 域通配角色）摸 CRM 工具 → unknown_role：业务全权 ≠ 跨域全权
curl -s http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'x-foundry-user: e004' -H 'x-foundry-role: hr_admin' \
  -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"list_accounts","arguments":{}}}'
```

## 签名身份（生产模式，W3 单网关 / W5 多签发方）

demo 头谁都能自称 hr_admin。设 `FOUNDRY_IDENTITY_SECRET`（≥16 字符）后服务器只认
HS256 签名令牌，`x-foundry-*` 头被完全忽略——伪造头不是"被拒绝"，是根本不在信任路径上：

```bash
export FOUNDRY_IDENTITY_SECRET='replace-with-a-16+char-secret'
pnpm --filter @yiong/foundry-server serve

# 签发令牌（演示里这条 CLI 扮演"网关"这个身份权威；生产由网关/SSO 持同一密钥签发）
pnpm --filter @yiong/foundry-server run mint-token --user e004 --role hr_admin --ttl 3600

# 用令牌访问（mint-token 会打印完整 curl 示例）
curl -s http://localhost:3100/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -H 'authorization: Bearer <token>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

改令牌任何一个字节（比如把 role 从 employee 改成 hr_admin）→ 签名作废 → 401；
过期 → 401；验签不读令牌自述的 alg，"alg: none" 一类降级攻击在结构上不成立。
飞书入口不走这条：sender open_id 由飞书服务端签发，本身就是可信身份源。

共享密钥要求签发方与验签方同持一把钥匙，适合单网关。多签发方 / 密钥轮换走
**非对称模式（W5）**：签发方持私钥，Foundry 只见公钥集（JWKS，ES256/RS256）——

```bash
# 签发方生成密钥对（私钥 0600 落盘，公钥 JWKS 写 jwks.json）
pnpm --filter @yiong/foundry-server run keygen --kid 2026-07

# 验签方只拿公钥集；设了 FOUNDRY_IDENTITY_JWKS 即切非对称模式（HS256 令牌不再有验签路径）
FOUNDRY_IDENTITY_JWKS=jwks.json pnpm --filter @yiong/foundry-server serve

# 签发走私钥（生产由网关/SSO 持有；Foundry 永远见不到私钥）
pnpm --filter @yiong/foundry-server run mint-token \
  --key identity-es256.key --kid 2026-07 --user e004 --role hr_admin
```

密钥轮换是运行时动作：新 kid 的 JWK 追加进 jwks.json（mtime 热重载，无需重启），
新旧键并存撑过渡窗口，删旧 JWK 即吊销。算法选择的纪律与 HS256 路径同一条——
用哪种算法由**被 kid 命中的受信密钥自己的 kty** 决定（EC→ES256 / RSA→RS256），
令牌头自述的 alg 从头到尾没人读；kid 只是受信集合内的查找提示，未命中与坏签名
同一个 401，不给探测者区分反馈。拿公钥当 HMAC 密钥的经典混淆攻击在这里没有
攻击面：JWKS 模式下不存在 HMAC 验签路径。

公钥集也可以直接指向签发方的 JWKS 端点（W6，签发方轮换后无需再往 Foundry 拷文件）：

```bash
# 值以 http(s):// 开头即走 URL 模式；启动拉一次，拉不到拒绝启动
FOUNDRY_IDENTITY_JWKS=https://sso.example.com/.well-known/jwks.json \
FOUNDRY_IDENTITY_JWKS_REFRESH=300 \
pnpm --filter @yiong/foundry-server serve
```

之后按 `FOUNDRY_IDENTITY_JWKS_REFRESH`（秒，默认 300）固定轮询刷新——带
ETag/If-None-Match，**忽略 Cache-Control**（这是刷新间隔，不是 HTTP 缓存 TTL）；
刷新失败沿用上一份有效集合并打含陈旧时长的警告。信任锚从网络来，运输纪律相应
收紧：只走 https（明文 http 仅放行 127.0.0.1/[::1] 本地调试，`localhost` 是名字
不是地址、不放行）；30x 重定向按失败处理（scheme 检查只管第一跳，所以不跟）；
响应限长 1 MiB（按实际读到的字节数数，不信任 Content-Length）、限时 10s；每次
密钥集变更打 kid 差集日志（只记 kid，不记密钥材料）。轮换纪律：新 kid 先发布到
端点、等 **≥2 个刷新间隔**（容一次失败轮询）再用它签发；删 kid 即吊销，最迟一个
刷新间隔生效。默认可用性优先——端点故障期间沿用旧集合、时延无上界；要 fail-closed
语义设 `FOUNDRY_IDENTITY_JWKS_MAX_STALE`（秒，须 ≥ 2×刷新间隔 + 10s 拉取超时——稳态
陈旧度会合法冲到「间隔+在途时延」，还要容一次失败轮询，更紧的截止对健康端点也会误伤）：
超过该时长没刷新成功，验签一律 401（304 也算刷新成功）。

签名令牌让第三方 Agent 平台零代码接入：Dify 已实测并**上了公网**（自托管 1.16）——
同一个网关地址挂两个 MCP server、只有令牌不同，两个 Agent 应用的工具面在 Dify 界面里
肉眼可见地不同（employee 3 个工具 / hr_admin 4 个），同问不同答、审计留痕（上面的两个
体验链接就是它们）。接入步骤与踩坑见 [docs/dify-integration.md](docs/dify-integration.md)，
上线清单见 [DEPLOY-CHECKLIST.md](DEPLOY-CHECKLIST.md)。

## 诚实边界

- 两条业务链路都已对真实系统验证：HR 对真实 OrangeHRM 5.7、CRM 对真实 EspoCRM 9.3
  （都是只读 MySQL、SELECT-only 账号），fixture 与真库双后端跑同一套 82 题均全绿，
  双域双真库组合亦全绿（[docs/espocrm-notes.md](docs/espocrm-notes.md)）；「已验证」
  指本地 docker 真库、演示数据口径，不是生产环境；ERP 仍是路线图。
- 演示与评测数据都是演示口径（HR 6 人；CRM 5 客户 / 5 联系人 / 5 商机 / 3 个销售身份），
  非生产数字。
- 角色不跨域：demo 身份（employee/hr_admin）不在 CRM 域的 RBAC 里，所以两个线上体验
  链接的工具面与行为**不因 CRM 域并入而改变**——线上网关是否已部署到含 CRM 的版本，
  只影响能否用 sales_* 令牌访问 CRM 工具。
- HTTP 入口两种生产验签：共享密钥 HS256（W3，单网关）与非对称 JWKS（W5 本地文件 /
  W6 URL 拉取，ES256/RS256，多签发方 + 热轮换）。**线上实例现跑 JWKS URL 模式**
  （W7，2026-07-17 切换）：Foundry 从 `https://foundry.yiongspace.com/jwks.json`
  拉公钥集，签发私钥只在管理员本机、服务器永不持有；两个体验链接的令牌已换成
  ES256（kid `2026-07-vps`，TTL 一年、2027-07 到期），旧 HS256 令牌即时作废。
  边界：URL 模式默认不设 max-stale——端点持续故障（宕机或被打瘫）期间**吊销不生效、
  时延无上界**，只有含陈旧时长的告警日志，要 fail-closed 得自己开
  `FOUNDRY_IDENTITY_JWKS_MAX_STALE`；启动时拉不到端点直接起不来（撞上端点故障的
  重启=停机，重试靠容器编排的 restart 策略，进程内不重试）。这里 JWKS 端点由
  Foundry 自己的 Caddy 静态供给（签发方=部署方同机），不是独立 SSO/IdP——
  「多签发方」是能力，线上是单签发方口径。不设任何密钥时回落 demo 头模式
  （启动时打警告），仅供本地演示与评测。
- 飞书链路三个域都已在真实飞书应用上端到端验证（HR + 记忆 2026-07-16；CRM
  2026-07-17，网页端实测：sales_rep 查自己的单出真数、联系人电话脱敏而邮箱可见、
  越权查同事商机被 row_denied 并如实转述「已记入审计」、跨域问工资零泄漏；
  hr_admin 反向无任何 CRM 能力；审计逐条留痕）。演示数据仍是 fixture 口径；
  机器人在飞书里的显示名/简介来自开发者后台的应用配置，与代码无关。
- 行级/字段规则只在 Guard 出口生效：绕过 Foundry 直连源系统它管不到——部署上要求源系统凭据只发给
  Foundry。
- **线上演示的身份是"配好的"，不是"登录来的"**：两个体验链接各自绑死一枚长效令牌，
  访客点开即是该身份，不能自己切换——这演示的是「同一网关、不同身份、行为不同」，
  不是一套面向访客的登录系统。生产接法是网关/SSO 在用户登录后按其真实身份签发令牌。
- 线上跑的是 fixture 后端（演示数据），不连真实 OrangeHRM/EspoCRM——两条真库链路都
  只在本地验证过（只读 MySQL，SELECT-only 账号）。
- 演示令牌 TTL 一年（2027-07 到期），现为 ES256（JWKS 模式）。过期后演示会静默失效——
  届时用 mint-token 拿本机私钥重签、更新 Dify 的 MCP server header（步骤见
  [DEPLOY-CHECKLIST.md](DEPLOY-CHECKLIST.md) 的「切换到 JWKS / 轮换演示令牌」）。

## 名称说明

mcp-foundry 是工作名（working title），正式名称待定；`@yiong/foundry-*` 包名前缀会随定名一起迁移。
