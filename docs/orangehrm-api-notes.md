# OrangeHRM 5.x API 对接笔记（adapter-orangehrm REST 模式）

状态：**核心认证问题已真机源码实测（2026-07-16，镜像 orangehrm/orangehrm:5.7）**，其余端点/字段仍按置信度分级待实测。改 `packages/adapter-orangehrm/src/rest.ts` 前先看下面的结论。

## ⚠️ 结论：client_credentials 不可用 → REST 模式改走「只读直连 MySQL」

源码实测 `src/plugins/orangehrmCoreOAuthPlugin/Server/OAuthServer.php`：只 `enableGrantType()` 了 **AuthCodeGrant + RefreshTokenGrant**，没有 ClientCredentialsGrant（`league/oauth2-server` vendor 里有这个类，但 OrangeHRM 没接线）；OAuth 插件的 entity 也只有 authorization_code / refresh_token 两种。

含义：**无人值守的 server-to-server 认证走不通**。authorization_code 需要人在浏览器登录授权，不适合后端 MCP 适配器常驻调用。

采用的替代方案（W-later 实现，不阻塞 W1）：REST 模式退化为 **只读直连 OrangeHRM 的 MySQL**（`hs_hr_employee` 等表），正好把 ai-edge 的 NL2SQL 四层守卫（词法掩码 / LIMIT 钳制 / stmt.readonly 断言 / 连接级只读）用上——坏消息变成多一层可演示的工程。fixture 模式仍是 W1~演示主路径，不受影响。

待验证：真实 DB schema（表名/字段名/工号列），需走完安装向导后 `docker exec ... mysql` dump 一次 `hs_hr_employee`。HTTP 版 authorization_code 半自动换票作为次要备选保留。

---

自测入口：起 `docker/orangehrm` 环境后，OrangeHRM 自带 Swagger 文档页（管理后台可开），逐条核对下表即可清掉「待实测」。下表的 OAuth token 部分已被上面的结论取代。

## 认证

| 事项 | 采用方案 | 置信度 | 备注 |
| --- | --- | --- | --- |
| Token 端点 | `POST {base}/web/index.php/oauth2/token`，`application/x-www-form-urlencoded` | 中 | 5.0~5.5 曾长期只有 cookie session；OAuth2 是 5.6+ 才重新提供的 |
| 授权类型 | `grant_type=client_credentials` + `client_id` + `client_secret` | **待实测** | 官方明确支持 authorization_code；client_credentials 是否开放没把握。若不支持，备选：① authorization_code + refresh_token 半自动换票；② 登录接口拿 session cookie 直调 API（v2 API 接受 cookie 认证） |
| Token 刷新 | 按 `expires_in` 提前 30s 重取 | 高 | 实现里没用 refresh_token，client_credentials 语义下重取即可 |
| OAuth 客户端注册入口 | 管理后台 Admin 菜单 | **待实测** | 具体路径（Admin → Configuration?）与是否给 UI 配 client_credentials 类型待确认 |

## 端点

统一前缀 `{base}/web/index.php/api/v2`。列表响应包 `{ data: [...], meta: { total } }`，单条响应包 `{ data: {...} }`（置信度：高）。

| 用途 | 端点 | 置信度 | 备注 |
| --- | --- | --- | --- |
| 员工列表 | `GET /pim/employees?model=detailed&limit=N&offset=M` | 中 | `model=detailed` 才带 jobTitle/subunit；参数名待实测，若无效退回默认 model 再单查 job-details |
| 员工联系方式 | `GET /pim/employees/{empNumber}/contact-details` | 中 | 字段 workEmail/otherEmail/workTelephone/mobile/homeTelephone |
| 员工岗位信息 | `GET /pim/employees/{empNumber}/job-details` | 中 | 当前实现未用（detailed 列表已带），留作 model=detailed 失效时的备选 |
| 年假余额 | `GET /leave/leave-entitlements?empNumber=X` | **待实测** | 也可能是 `/leave/employees/{empNumber}/leave-balances` 这类端点；已用天数字段名 daysUsed/usedDays 两个候选都做了兼容解析 |
| 薪资 | `GET /pim/employees/{empNumber}/salary-components` | 中 | 取第一条金额可解析的组件；`amount` 可能是字符串 |

## 字段映射（统一行结构 ← OrangeHRM）

| 统一字段 | OrangeHRM 来源 | 置信度 | 备注 |
| --- | --- | --- | --- |
| `employee_id` | `employeeId`（PIM 里人工填的工号） | 高 | **不是** `empNumber`（内部自增主键）；端点寻址用 empNumber，适配器维护 employeeId→empNumber 缓存，未命中时全量拉列表重建。演示库需要把工号录成 e001~e006 |
| `name` | `firstName + middleName + lastName` 空格拼接 | 中 | 中文录入习惯不统一（全名塞 firstName vs 姓/名分开），拼接顺序**待实测**，可能出现「三 张」倒序 |
| `dept` | `subunit.name`（组织结构子单元） | 中 | dept 过滤在适配器侧做精确匹配，不依赖服务端过滤参数 |
| `title` | `jobTitle.title` | 中 | |
| `email` | `workEmail`，退化 `otherEmail` | 中 | |
| `phone` | `workTelephone` → `mobile` → `homeTelephone` | 中 | |
| `annual_total` | 名称含 Annual/年假 的 entitlement 的 `entitlement` | **待实测** | 找不到匹配假种时退回第一条；员工存在但无 entitlement 时返回全 0 而非 null |
| `annual_used` | 同上的 `daysUsed`（或 `usedDays`） | **待实测** | 字段名不确定，两个都解析；都缺时按 0 处理 |
| `annual_left` | total - used 由适配器计算 | 高 | 不信任服务端的 balance 字段，口径自己算 |
| `salary` | 第一条 salary component 的 `amount` | 中 | 多组件（基本工资+补贴）时只取第一条，口径**待实测** |
| `currency` | `currencyType.id`（退化 `.name`） | **待实测** | id 是否就是 "CNY" 这类 ISO 码没把握 |
| `effective_date` | **无对应字段** | 高 | OrangeHRM 薪资组件不带生效日期，REST 模式固定返回空串；fixture 模式返回 "2026-01-01"。上层文案别在 REST 模式下引用该字段 |

## 其他已知约束

- 404 归一化为 `null`（"查不到"不是错误）；其余非 2xx 抛错，由守卫管线转成 error 分支，业务数据不外带。
- 员工列表分页 `limit/offset`，实现按页拉全量后本地过滤——演示库 6 人无所谓；上生产要换成服务端过滤参数（`nameOrId`? 待实测）。
- v2 API 默认只返回未离职员工还是包含离职（`includeEmployees` 参数），**待实测**；影响 list_employees 口径。

## 待实测清单（按优先级）

1. ~~client_credentials 是否可用~~ ✅ 已实测：**不支持**，REST 模式改走只读 MySQL（见顶部结论）
2. 真实 DB schema：`hs_hr_employee` 及关联表的字段名/工号列（MySQL 兜底适配器依赖）
3. leave 余额、salary 在 DB 里的表与口径（走 SQL 后端点笔记作废，改看表）
4. 中文姓名的拼接顺序（DB 里 emp_firstname/emp_lastname 分列）
