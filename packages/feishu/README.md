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
- **多系统**：HR（OrangeHRM）、CRM（EspoCRM）与记忆（跨会话）三个域各自 RBAC——
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
# ESPOCRM_MYSQL_*（可选：有则 CRM 走真库，否则 fixture）
# 3. 启动（长连接，无需公网回调）
pnpm --filter @yiong/foundry-feishu serve
```

首次给 bot 发消息，它会回复你的 open_id；写进 `config/identity.feishu.yaml`
（例：`ou_xxx: { userId: e002, role: employee }`）**保存即生效，无需重启**——
身份表每条消息重读，解析失败沿用上一份有效映射。把同一个 open_id 在
`employee` 与 `hr_admin` 之间切换，即可现场演示"同问不同答"的权限对比；
切成 `{ userId: e007, role: sales_rep }` 则工具面换成 CRM 五工具 + 私有记忆
——业绩盘、HR 工具都不在模型的工具列表里（正常对话模型根本不会调它们，只会说
自己没有这个能力；若模型硬调列表外工具，守卫按 tool_not_allowed / unknown_role
拒并留审计——这层由单测与评测钉住）。
**注意：CRM 域在飞书里的表现尚未真机复验**（HR + 记忆两域 2026-07-16 已真机验证）；
绑 sales 身份实测通过前，别把上面的行为当已验证能力演示。

## 模块

| 文件 | 职责 |
| --- | --- |
| `identity.ts` | open_id → principal 映射 |
| `toolset.ts` | 多系统守卫工具集：按身份收窄 + 按名路由到各系统守卫 |
| `llm.ts` | OpenAI 兼容 tool-calling 循环（可关思考链降延迟） |
| `agent.ts` | 系统提示词 + 工具执行编排（拒答如实转述、不越权补数） |
| `bot.ts` | 长连接接入；处理中用表情回应反馈（答完摘掉，零残留），答案作为新消息发出以触发自动滚屏；单聊不开线程，群聊保留引用回复 |
