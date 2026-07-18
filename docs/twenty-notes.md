# Twenty CRM 对接笔记（adapter-twenty）

状态：**第二个 CRM 后端，与 adapter-espocrm 同工具面、同守卫、同 demo 数据**。
网关按 `FOUNDRY_CRM_BACKEND=espocrm|twenty` 二选一（工具名是扁平命名空间，两个 CRM
不能同时注册，会撞名）。fixture 模式已本地验证：切到 twenty 后端后，tools/list、
行级过滤、字段脱敏、审批闸门、写前归属校验的行为与 espocrm 逐项一致。

## 为什么加它（而不是替换 espocrm）

证明「守卫做在基础设施层、与 CRM 后端无关」：同一套 `config/rbac.twenty.yaml`（内容与
`rbac.espocrm.yaml` 相同）、同一批 demo 身份、同一套工具，换个适配器就换了后端，上层零改动。
配合「前端可插拔」（Dify / 飞书 / LangGraph 三个客户端连同一网关），得到「前端后端全可热插拔」。

## 接口（已查证，2026-07）

- Core API：`/rest/`（也有 `/graphql/`），本适配器走 REST
- 认证：`Authorization: Bearer <API_KEY>`（后台 Settings → API & Webhooks 生成，可按角色限权）
- 自部署：`https://<你的域名>/rest/`；云：`https://api.twenty.com/rest/`
- 对象：People（联系人）/ Companies（客户）/ Opportunities（商机）+ 自定义对象
- 启用真库写通道：`.env` 设 `TWENTY_API_URL` + `TWENTY_API_KEY`（可选 `TWENTY_OWNER_FIELD`）

来源：<https://docs.twenty.com/developers/extend/api>

## 字段映射（统一行结构 ↔ Twenty）

| 统一行结构 | Twenty 字段 | 说明 |
| --- | --- | --- |
| `contact` 的 `name` | `name.{firstName,lastName}` | Twenty 姓名是复合对象；本适配器把整名写进 `lastName`（中文不拆姓氏） |
| `title` | `jobTitle` | |
| `email` | `emails.primaryEmail` | Twenty 邮箱是复合字段（另有 additionalEmails） |
| `phone` | `phones.primaryPhoneNumber` | 同上 |
| `account_id`（联系人所属） | `companyId` | 关系字段 |
| `opportunity` 的 `amount` | `amount.amountMicros` | Twenty 金额是「百万分之一」，读时 /1e6、口径 CNY |
| `owner_id`（归属） | 由 `TWENTY_OWNER_FIELD` 指定，缺省 `ownerId` | **见下方待实测** |

## 诚实边界（待实测）

REST 后端**未对真实 Twenty 实例端到端实测**，但字段/包封形状已据 Twenty 官方源码核对
（自审阶段查证并修复了三处）。单测用注入 fetch 按真实形状覆盖映射逻辑。改映射先改本节：

已据 Twenty 源码核对并处理（回归测试钉住）：
- **响应包封**：GET 单条 `{data:{person}}`、列表 `{data:{people}}`；**写操作包在操作名键下**
  `{data:{createPerson}}` / `{data:{updatePerson}}` / `{data:{updateOpportunity}}`——unwrapOne
  依次试候选键，再退回「data 下唯一对象值」兜底，故各操作名键通用。
- **金额**：`amount.amountMicros` 是 BigInt，JSON 里序列化成【字符串】，schema 收 number|string，
  读时 `Number()` 归一后 /1e6。
- **姓名**：Twenty 姓名复合 `{firstName,lastName}`，读回用空格拼接（John Smith）；本适配器写入时
  整名入 lastName、firstName 空，中文单名不会多前导空格。

仍待真库验证：
- **owner/归属**：Twenty 默认没有「负责人」内建字段。`owner_id` 映射到可配置字段（缺省 `ownerId`，
  `TWENTY_OWNER_FIELD` 可改）——真库需在 People/Companies/Opportunities 建对应自定义字段，
  否则归属为空、行级过滤会「宁可错拒」。fixture 后端不受此限（自带 owner_id）。
- **商机阶段枚举**：沿用 EspoCRM 缺省阶段（Prospecting…Closed Lost）以便对照；Twenty 默认枚举不同
  （NEW/SCREENING/…），真库需把 `update_opportunity_stage` 的枚举与工作区实际阶段对齐。
- **创建归属**：`create_contact` 从 principal 盖 `owner_id` 到自定义字段；Twenty 另有 `createdBy`
  系统字段不可写，两者语义需按工作区约定对齐。
