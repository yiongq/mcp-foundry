# Twenty CRM 对接笔记（adapter-twenty）

状态：**CRM 域的后端，fixture 与真实 Twenty REST 两种模式同工具面、同守卫、同 demo 数据**。
设了 `TWENTY_API_URL` + `TWENTY_API_KEY` 即连真库 REST（Bearer），否则回落 fixture 演示数据。
两种模式下 tools/list、行级过滤、字段脱敏、审批闸门、写前归属校验行为逐项一致；线上
`crm.yiongspace.com` 跑的就是真实 Twenty。

## 为什么用适配器隔离后端

证明「守卫做在基础设施层、与 CRM 后端无关」：同一套 `config/rbac.twenty.yaml`、同一批 demo
身份、同一套工具，换个适配器就换了后端，上层零改动（本项目早期 CRM 后端即是这样迁到 Twenty 的）。
配合「前端可插拔」（LangGraph / 飞书 / 任意 MCP host 连同一网关），得到「前端后端全可热插拔」。

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

## 诚实边界

REST 后端**已对真实自托管 Twenty 实例端到端验证**（线上 crm.yiongspace.com，读写真数据）。
下列坑是真库联调时实测出来并修复的，单测用注入 fetch 按真实形状覆盖映射逻辑。改映射先改本节：

已据真库实测核对并处理（回归测试钉住）：
- **响应包封**：GET 单条 `{data:{person}}`、列表 `{data:{people}}`；**写操作包在操作名键下**
  `{data:{createPerson}}` / `{data:{updatePerson}}` / `{data:{updateOpportunity}}`——unwrapOne
  依次试候选键，再退回「data 下唯一对象值」兜底，故各操作名键通用。
- **金额**：`amount.amountMicros` 是 BigInt，JSON 里序列化成【字符串】，schema 收 number|string，
  读时 `Number()` 归一后 /1e6。
- **姓名**：Twenty 姓名复合 `{firstName,lastName}`，读回用空格拼接（John Smith）；本适配器写入时
  整名入 lastName、firstName 空，中文单名不会多前导空格。

部署时按工作区对齐（线上已按此配好）：
- **owner/归属**：Twenty 默认没有「负责人」内建字段。`owner_id` 映射到可配置字段
  （`TWENTY_OWNER_FIELD`）。**线上用自定义 TEXT 字段 `repCode`**（值即令牌里的 userId，如 `e007`）——
  给 Company/Person/Opportunity/Order/Refund 各加一个 `repCode`，令牌 userId 与之比对做行级过滤。
  （早期用内建关系字段 `accountOwnerId`，但它是 workspaceMember UUID、与「员工号」口径对不上，
  且默认样例数据归属为空 → 换 `repCode` 后 sales_rep 行过滤才真在真库上生效。）
- **商机阶段枚举**：Twenty 默认阶段（NEW/SCREENING/…）与工作区可能不同，真库需把
  `update_opportunity_stage` 的枚举与实际阶段对齐。
- **创建归属**：`create_contact` 从 principal 盖 `owner_id` 到归属字段；Twenty 另有 `createdBy`
  系统字段不可写，两者语义需按工作区约定对齐。

## 退款：Twenty 自定义对象 Order / Refund（真库已跑通）

Twenty 无内置「订单/退款」对象，故建两个**自定义对象**承载 `issue_refund`（线上真库端到端验证）：

| 自定义对象 | 字段（除内建 `id`/`name`/`createdAt`） | 说明 |
| --- | --- | --- |
| `order`（orders） | `email` · `lastFour` · `amountPaid`(NUMBER) · `repCode` | `name` 存订单号（ord-1001）；`email`+`lastFour` 是退款身份核验凭据 |
| `refund`（refunds） | `orderCode` · `amount`(NUMBER) · `status` · `repCode` | `issue_refund` 成功即建一条，归属随订单盖 `repCode` |

建法（一次性，元数据 REST API）：`POST /rest/metadata/objects` 建对象，`POST /rest/metadata/fields`
逐个加字段（`{name,label,type:TEXT|NUMBER,objectMetadataId}`）。数据读写走 `/rest/orders`、`/rest/refunds`。
REST 后端按 `name` 客户端匹配订单（记录数小，不依赖 Twenty 的 `filter` 语法）；`refundCountThisMonth`
按 `repCode` + 本月 `createdAt` 计数供频次分级。真实 Twenty 校验手机号（libphonenumber），种子联系人
电话需合法格式（带 `+86`）。
