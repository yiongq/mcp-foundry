# @yiong/foundry-feishu

飞书 bot 入口层：把「谁在问」透传给 Foundry 守卫，用自然语言驱动带权限的企业数据查询。

## 它做什么

- **身份透传**：飞书事件里的 sender `open_id`（服务端签发，客户端伪造不了）经
  `config/identity.feishu.yaml` 映射成 Foundry principal。绑定是管理动作，
  不提供任何"自助声明角色"的通道；未绑定用户只收到自己的 open_id 引导，拿不到数据。
- **按身份收窄的工具面**：LLM 看到的工具列表已按角色过滤——员工的工具定义里根本
  没有 `get_salary`。安全发生在模型看到工具之前，而非调用被拒之后。
- **守卫兜底**：模型选的每次工具调用都过 `packages/core` 的 Guard（行级过滤、
  字段脱敏、结构化拒答、审计）。拒答分支没有 data 字段，模型想编也没材料。
- **多系统**：HR（OrangeHRM）、CRM（Twenty）与记忆（跨会话）三个域各自 RBAC——
  业务全权 ≠ 记忆全权，且角色不跨域（hr_admin 的通配进不了 CRM，sales_* 也进不了 HR）。

## 跑起来

```bash
# 1. 建应用（open.feishu.cn 开发者后台）：企业自建应用 + 机器人能力
#    权限 im:message / contact:user.base:readonly（表情回应进度提示需消息表情权限，缺失自动降级）
#    事件订阅：长连接模式 + im.message.receive_v1；发布版本
# 2. 配置
cp config/identity.feishu.example.yaml config/identity.feishu.yaml   # 先留空
cp packages/feishu/.env.example packages/feishu/.env                 # 填凭据与模型
# FEISHU_APP_ID / FEISHU_APP_SECRET
# FOUNDRY_LLM_BASE_URL / _API_KEY / _MODEL（OpenAI 兼容，如智谱 glm-4.6）
# ORANGEHRM_MYSQL_*（可选：有则 HR 走真库，否则 fixture）
# TWENTY_API_*（可选：有则 CRM 走真实 Twenty REST，否则 fixture）
# 3. 启动（长连接，无需公网回调）
pnpm --filter @yiong/foundry-feishu serve
```

首次给 bot 发消息，它会回复你的 open_id；写进 `config/identity.feishu.yaml`
（例：`ou_xxx: { userId: e002, role: employee }`）**保存即生效，无需重启**——
身份表每条消息重读，解析失败沿用上一份有效映射。把同一个 open_id 在
`employee` 与 `hr_admin` 之间切换，即可现场演示"同问不同答"的权限对比；
切成 `{ userId: e007, role: sales_rep }` 则工具面换成 CRM 十工具（六读 + 四写：
create/update/delete_contact、update_opportunity_stage）+ 私有记忆——业绩盘、HR 工具
都不在模型的工具列表里（正常对话模型根本不会调它们，只会说自己没有这个能力；若模型
硬调列表外工具，守卫按 tool_not_allowed / unknown_role 拒并留审计——这层由单测与评测钉住）。
四个写工具里改/删/改阶段三个涉人工审批（create 免审）：模型调用 → 闸门返回 pending
→ 会话弹审批卡片 → 经理点同意/拒绝 → 批准后自动续跑并把结果推回原对话（见
[审批闸门](#审批闸门w9)一节；须在飞书控制台把 `card.action.trigger` 回调订阅为长连接）。
三个域均已真机验证（HR + 记忆 2026-07-16；CRM 2026-07-17，网页端实测：自己的单
出真数、联系人 phone 脱敏 email 可见、越权查同事商机 row_denied 且转述审计提示、
跨域问工资零泄漏、hr_admin 反向无 CRM 能力、审计逐条留痕）。
一个已知的非安全性小坑：机器人在会话里的**显示名/简介来自飞书开发者后台的应用
配置**，不随代码变——多域之后建议在后台改成与域无关的名字（如「Foundry 数据助手」）
并发布新版本。

## 审批闸门（W9）

CRM 写工具里改/删/改阶段涉人工审批。链路：模型调涉审工具 → 守卫返回 `pending`
（发起人越权改写在此之前就被行级前置校验拦掉，连审批单都不开）→ `bot.ts` 把待审
单据发成审批卡片（同意/拒绝按钮）→ 经理点按触发 `card.action.trigger` 回调
（长连接接收，无需公网 URL）→ `approval.ts` 校验点按人是本域 `approver` → 批复落库
→ 卡片原地翻面 → 批准则**以发起人当前身份**（重解身份表，非单据旧角色）自动续跑、
结果推回原对话。前提：飞书控制台「事件与回调」把 `card.action.trigger` 订阅为长连接；
可选 `FEISHU_APPROVAL_CHAT_ID` 指定审批卡片投递会话（缺省发到触发对话本身）。
审批单据落 `audit/approvals.feishu.jsonl`（与网关进程的单据各管各的）。

## 飞书「只当审批人」（relay 模式）

上面的 `bot.ts` 是**自成一体**的聊天+审批 bot（自己发起、自己出卡、自己的审批库）。
若要飞书**只做网页网关（packages/server）请求的审批人**——网页=发起人、飞书=独立审批人——
用 relay 模式（`relay.ts` + `bin/serve-approver.ts`）：

```bash
FEISHU_APPROVAL_CHAT_ID=<审批人会话> \
FOUNDRY_GATEWAY_URL=http://127.0.0.1:3100 \
FOUNDRY_APPROVER_USER=e005 FOUNDRY_APPROVER_ROLE=sales_manager \
pnpm --filter @yiong/foundry-feishu run serve-approver
# 生产改用 FOUNDRY_APPROVER_TOKEN=<签名令牌>
```

链路：relay 轮询网关 `GET /approvals` 拿待审批单 → 发飞书卡片 → 审批人点批 →
relay 回传 `POST /approvals/{id}`（以审批人身份）→ 网关落库。**relay 不聊天、不嵌网关、
不落自己的库、不执行**——网关是唯一真源，执行仍由发起人在网页侧重试消票完成。职责分离由
网关代码级 self-approval 不变量兜底（`principal.userId===record.userId → 403`）。

> 注：网页在提交 pending 后自动感知「批复结果并续跑执行」尚未闭环（web 侧轮询/重试），是下一步。

## 模块

| 文件 | 职责 |
| --- | --- |
| `identity.ts` | open_id → principal 映射 |
| `toolset.ts` | 多系统守卫工具集：按身份收窄 + 按名路由到各系统守卫 |
| `llm.ts` | OpenAI 兼容 tool-calling 循环（可关思考链降延迟） |
| `agent.ts` | 系统提示词 + 工具执行编排（拒答如实转述、不越权补数；pending 结果旁路给 bot 出卡片） |
| `approval.ts` | 审批卡片构造 + `card.action.trigger` 回调处理（审批人校验、批复落库、卡片翻面、批准后自动续跑） |
| `bot.ts` | 长连接接入；处理中用表情回应反馈（答完摘掉，零残留），答案作为新消息发出以触发自动滚屏；单聊不开线程，群聊保留引用回复；订阅 cardAction 驱动审批 |
| `relay.ts` | 「飞书只当审批人」：轮询网页网关待审批单发卡、把批复回传网关（不聊天/不执行）；纯逻辑，单测覆盖 |
