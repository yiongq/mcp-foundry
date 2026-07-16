# mcp-foundry（工作名）

> Guarded MCP gateway for internal business systems — role-scoped tools, row/field-level data
> guards, and a per-call audit trail.

把内部系统（先做 HR，现已加上 CRM 演示域）接到 MCP 上，并在协议层前面加一道守卫：
谁、能用哪些工具、能看到哪些行哪些字段，问过什么都有账可查。

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
│ packages/core  Guard 管线                   │◀────（角色→工具 / 行规则 / 脱敏字段）
│ 角色查找 → 工具白名单 → 行级过滤 → 字段脱敏    │
│ → 审计 JSONL（audit/foundry.jsonl）          │
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

配套：`packages/eval` 是越权/泄漏评测——77 题跨三个域（HR 29 + 记忆 20 + CRM 28，
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

## 签名身份（生产模式，W3）

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

签名令牌让第三方 Agent 平台零代码接入：Dify 已实测并**上了公网**（自托管 1.16）——
同一个网关地址挂两个 MCP server、只有令牌不同，两个 Agent 应用的工具面在 Dify 界面里
肉眼可见地不同（employee 3 个工具 / hr_admin 4 个），同问不同答、审计留痕（上面的两个
体验链接就是它们）。接入步骤与踩坑见 [docs/dify-integration.md](docs/dify-integration.md)，
上线清单见 [DEPLOY-CHECKLIST.md](DEPLOY-CHECKLIST.md)。

## 诚实边界

- 两条业务链路都已对真实系统验证：HR 对真实 OrangeHRM 5.7、CRM 对真实 EspoCRM 9.3
  （都是只读 MySQL、SELECT-only 账号），fixture 与真库双后端跑同一套 77 题均全绿，
  双域双真库组合亦全绿（[docs/espocrm-notes.md](docs/espocrm-notes.md)）；「已验证」
  指本地 docker 真库、演示数据口径，不是生产环境；ERP 仍是路线图。
- 演示与评测数据都是演示口径（HR 6 人；CRM 5 客户 / 5 联系人 / 5 商机 / 3 个销售身份），
  非生产数字。
- 角色不跨域：demo 身份（employee/hr_admin）不在 CRM 域的 RBAC 里，所以两个线上体验
  链接的工具面与行为**不因 CRM 域并入而改变**——线上网关是否已部署到含 CRM 的版本，
  只影响能否用 sales_* 令牌访问 CRM 工具。
- HTTP 入口的验签是共享密钥 HS256（W3）：签发方与验签方同持一把密钥，适合单网关部署；
  多签发方、密钥轮换要上非对称签名（JWKS），在路线图上。不设密钥时回落 demo 头模式
  （启动时打警告），仅供本地演示与评测。
- 飞书链路的 HR + 记忆两域已在真实飞书应用上端到端验证（2026-07-16，网页端实测：
  员工被结构化拒答、hr_admin 正常出数、审计留痕）；CRM 域挂载（2026-07-17）后的
  飞书链路只过了单测与评测，**尚未真机复验**——绑一个 sales_* 身份实测前，
  不要把"飞书里问 CRM"当作已验证能力宣传。演示数据仍是 fixture 口径。
- 行级/字段规则只在 Guard 出口生效：绕过 Foundry 直连源系统它管不到——部署上要求源系统凭据只发给
  Foundry。
- **线上演示的身份是"配好的"，不是"登录来的"**：两个体验链接各自绑死一枚长效令牌，
  访客点开即是该身份，不能自己切换——这演示的是「同一网关、不同身份、行为不同」，
  不是一套面向访客的登录系统。生产接法是网关/SSO 在用户登录后按其真实身份签发令牌。
- 线上跑的是 fixture 后端（演示数据），不连真实 OrangeHRM/EspoCRM——两条真库链路都
  只在本地验证过（只读 MySQL，SELECT-only 账号）。
- 演示令牌 TTL 一年（2027-07 到期）。过期后演示会静默失效——届时用 mint-token 重签
  并更新 Dify 的 MCP server header。

## 名称说明

mcp-foundry 是工作名（working title），正式名称待定；`@yiong/foundry-*` 包名前缀会随定名一起迁移。
