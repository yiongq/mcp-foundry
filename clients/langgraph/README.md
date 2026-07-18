# Foundry LangGraph 客户端

> 同一个网关，换一个框架。用 [LangGraph](https://github.com/langchain-ai/langgraph) +
> [langchain-mcp-adapters](https://github.com/langchain-ai/langchain-mcp-adapters)
> 接上 mcp-foundry 网关的自建对话客户端——证明守卫（角色收窄 / 行级过滤 / 字段脱敏 /
> 人工审批 / 审计）做在基础设施层，与 agent 框架无关。

Dify 用的是这个网关，飞书 bot 用的是这个网关，这个 LangGraph 客户端也是这个网关——
三个不同框架、同一条 `POST /mcp`，拿到的是各自身份收窄后的同一套安全边界。
本客户端**一行策略代码都没有**：工具面已被网关按身份收窄，越权数据在网关出口就不存在，
高危写被闸门挡在执行前。它只负责把身份头带上、把对话流式渲染出来。

## 它长什么样

- 流式对话（token 逐字出）、工具调用状态行（执行中 / 已完成 / 被拒）
- 高危写（改/删联系人、改商机阶段）触发**对话内审批卡片**：同意 → 自动续跑 → 结果回填；
  拒绝 → 明示不执行。审批走网关的 `/approvals` 端点，审批权由网关按域校验。
- 设计语言与 [落地页](../../landing) 同源（Geist 字体、暖米色系、sage 绿），浅/深色皆备

## 跑起来

```bash
cd clients/langgraph
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

# 另开一个终端起网关（fixture 模式，demo 头鉴权，无需密钥）：
#   pnpm --filter @yiong/foundry-server serve   # → http://localhost:3100/mcp

cp .env.example .env      # 填 FOUNDRY_LLM_API_KEY（GLM/DeepSeek/任意 OpenAI 兼容）
.venv/bin/python -m app   # → http://127.0.0.1:8100
```

缺 `FOUNDRY_LLM_API_KEY` 时服务照常起——页面、身份信息、审批代理都能用，只有对话本身
会提示未启用。身份切换：改 `.env` 的 `FOUNDRY_MCP_USER/ROLE`（如换成 `e005/sales_manager`
则写操作免审直通）。

## 演示脚本（录视频用）

1. 问「哪些客户在苏州？联系人是谁」→ 流式作答，工具行显示 `list_accounts` / `list_contacts` 已完成
2. 说「删除刘敏这个联系人」→ 工具行转「待审批」，对话里弹出审批卡片
3. 点「同意并执行」→ 卡片翻绿、自动重发原请求 → 网关消票执行 → 助手回「已删除」
4. （对照）说「删掉周涛」（周涛归属另一个销售）→ 直接 `row_denied`，连审批单都不开——
   写前归属校验把越权写挡在执行与审批之前

## 架构

```
自建聊天前端 (web/)  ──POST /api/chat (SSE)──►  FastAPI (app/server.py)
                                                    │
                          astream_events 映射为 token/tool/pending 事件
                                                    ▼
                            LangGraph react agent (app/agent.py)
                                                    │ langchain-mcp-adapters
                                                    ▼
                        mcp-foundry 网关  POST /mcp   （身份头透传）
                                                    │  ← 同一个网关，Dify/飞书也连这里
                          GuardedResult(ok|refusal|pending|error) 原样回流
                                                    │
       审批：前端 ──/api/approvals──► FastAPI 代理 ──► 网关 /approvals（审批人身份）
```

## 模块

| 文件 | 职责 |
| --- | --- |
| `app/config.py` | 环境变量 → 网关身份 / 审批人身份 / LLM 配置；令牌优先于 demo 头，无身份拒启动 |
| `app/gateway.py` | 连网关拉工具面；把 MCP 工具输出（内容块列表）归一并识别 `kind=pending` |
| `app/agent.py` | ChatOpenAI + `create_react_agent`；系统提示词对 GuardedResult 各分支的口径与飞书入口一致 |
| `app/approvals.py` | `/approvals` 决策的薄代理（透传审批人身份；审批权判定在网关） |
| `app/server.py` | FastAPI：SSE 流式对话、审批 API、静态托管 |
| `web/` | 自建聊天前端（自包含 HTML/CSS/JS，复用落地页设计 token） |

## 测试

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest        # 纯逻辑单测（工具输出解析 / 身份优先级 / SSE 事件映射）
.venv/bin/ruff check .

# 与真实网关的集成测试（默认跳过）——先起网关，再：
FOUNDRY_TEST_LIVE=1 .venv/bin/pytest tests/test_live_gateway.py -v
```

集成测试无需 LLM，纯工具层就把「身份收窄 → 写挂起 → 批准续跑 → 跨主写拒绝」的
HITL 闭环走完，是「LangGraph ↔ 网关」这个最吃劲集成点的真机证据。

## 诚实边界

- 全链路已用真实 GLM key 在浏览器里端到端验证过：读（工具调用 + 表格渲染）、
  写（联系人 → pending → 审批卡片）、批准（服务端直接消票执行 → 卡片翻绿）。
  但**提交进仓的自动化测试仍对 LLM 打桩**（假 agent 驱动 SSE），因为 CI / 他人没有 key；
  真机对话需自备 `FOUNDRY_LLM_API_KEY`。
- 批准后的续跑是**服务端按单据 tool+args 直接重发**（非让 LLM 重发）——线程有记忆时
  LLM 会以为已提交、不再调工具，票永远消费不掉；直接重发确定消票，且 argsHash 一致。
- Python 服务不进主仓的 pnpm CI（不同工具链）；质量门是本目录的 pytest + ruff，手动或另配。
- 尚未替换线上 Dify；本客户端与 Dify 可并存同连一个网关（这正是框架无关的实景证据）。
