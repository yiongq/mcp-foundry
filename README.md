# mcp-foundry（工作名）

> Guarded MCP gateway for internal business systems — role-scoped tools, row/field-level data
> guards, and a per-call audit trail.

把内部系统（先做 HR）接到 MCP 上，并在协议层前面加一道守卫：谁、能用哪些工具、能看到哪些行哪些字段，
问过什么都有账可查。

## 为什么做：三个事故 → 三个能力

给 Agent 接内部系统，出的事基本是三类：普通员工顺嘴一问就拿到了同事的工资（没有行级边界）；
模型"好心"把带手机号、薪资的整行数据吐进回答（没有字段脱敏）；出事之后翻不出谁在什么时候问过什么
（没有审计）。对应地，Foundry 只做三件事：**角色 → 工具白名单**——不该用的工具连 tools/list
都不出现，而不是调用被拒之后再解释；**行级过滤 + 字段脱敏**——结构化规则在守卫出口强制执行，
不靠提示词自觉；**每次调用一条审计流水**——只记参数哈希不记原文，审计日志本身不成为第二个泄漏面。
拒答是结构化分支，结构上不可能夹带业务数据。

## 架构

```
MCP 客户端（Claude Code / 任意支持 Streamable HTTP 的 host）
        │  POST /mcp（headers: x-foundry-user / x-foundry-role）
        ▼
┌────────────────────────────────────────────┐
│ packages/server（@yiong/foundry-server）    │
│ 无状态：每请求 new 一个 McpServer，          │
│ 只注册该角色白名单内的工具                    │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐     config/rbac.*.yaml
│ packages/core  Guard 管线                   │◀────（角色→工具 / 行规则 / 脱敏字段）
│ 角色查找 → 工具白名单 → 行级过滤 → 字段脱敏    │
│ → 审计 JSONL（audit/foundry.jsonl）          │
└──────────────────┬─────────────────────────┘
                   ▼
┌────────────────────────────────────────────┐
│ SystemAdapter：orangehrm                    │    CRM / ERP …（路线图，今天没有）
│   fixture / 只读 MySQL（真实 OrangeHRM 5.7） │
│              ：memory（跨会话记忆，域内 RBAC）│
└────────────────────────────────────────────┘
```

配套：`packages/eval` 是越权/泄漏评测——47 题（含跨会话记忆召回与越权记忆泄露）、
硬断言 + LLM-judge 双轨（judge 须先过人工校准）、3 次重复报方差、守卫逐层开/关
ablation 曲线。CI 的 eval-gate 在 fixture 上跑并上传报告；方法与实测数据见
[docs/eval-methodology.md](docs/eval-methodology.md)。

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

## 诚实边界

- 已验证的只有 HR（OrangeHRM）这一条链路——fixture 与真实 OrangeHRM 5.7（只读 MySQL，
  SELECT-only 账号）两种后端跑同一套 47 题评测均全绿；CRM/ERP 在路线图上，接口留了
  适配器位，但今天没有实现。
- 演示与评测数据都是 6 人演示口径（fixture 内置 / 真库种子脚本灌入），非生产数字。
- 身份目前来自请求头（demo 信任层，不验签）；生产身份接飞书事件/网关签名（W3）之后才算闭环。
- 行级/字段规则只在 Guard 出口生效：绕过 Foundry 直连源系统它管不到——部署上要求源系统凭据只发给
  Foundry。

## 名称说明

mcp-foundry 是工作名（working title），正式名称待定；`@yiong/foundry-*` 包名前缀会随定名一起迁移。
