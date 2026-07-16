# EspoCRM 对接笔记（adapter-espocrm，fixture-first）

状态：**CRM 域已进网关与评测（2026-07-16），但只有 fixture 后端**。实体与字段按
EspoCRM 公开文档与源码 metadata（entityDefs）建模，**尚未对真实 EspoCRM 实例验证**——
下表全部按置信度分级，动 `packages/adapter-espocrm` 的真实后端前先清掉「待实测」。

## 为什么选 EspoCRM 当第二个域

- 开源（GPLv3）、PHP + MySQL、官方 docker 镜像（`espocrm/espocrm`），本地起真库的
  成本与 OrangeHRM 相当，「只读直连 MySQL（SELECT-only 账号）」这条已验证的路径可以
  照搬（见 docs/orangehrm-api-notes.md 的结论）。
- REST 这条路 EspoCRM 比 OrangeHRM 友好：支持 API 用户 + `X-Api-Key` 头认证，
  无人值守 server-to-server 不需要 OAuth 授权码——真实后端做哪条待定，两条都留了口。
- 实体模型干净：Account / Contact / Opportunity 三个实体覆盖「客户-联系人-商机」
  的最小 CRM 叙事，销售阶段是缺省枚举（Prospecting…Closed Lost），不用自造词表。

## 统一行结构 ← EspoCRM 字段映射（计划）

适配器行结构统一 snake_case，`assigned_user_id` 归一为 `owner_id`——RBAC 行规则
（`owner_id == $self.userId`）只认这一个归属字段，与 HR 域的 `employee_id` 同构。

| 统一行结构 | EspoCRM（表.列） | 置信度 | 备注 |
| --- | --- | --- | --- |
| account_id | `account.id` | 高 | 真库是 17 位随机串；fixture 用可读 id（a001…），适配器不做映射、原样返回 |
| name（account） | `account.name` | 高 | |
| industry | `account.industry` | 高 | varchar 枚举 |
| owner_id | `account.assigned_user_id` | 高 | 归一命名 |
| website | `account.website` | 高 | |
| phone（account） | `phone_number` 关联表 | **待实测** | Espo 的电话/邮箱存独立表（`entity_phone_number` join），不在主表 |
| city | `account.billing_address_city` | 中 | |
| contact_id / name | `contact.id`、`first_name` + `last_name` 拼接 | 高 | 中文名拼接顺序待定 |
| title（contact） | 待确认 | **待实测** | 职务字段可能在 contact 主表，也可能在 account-contact 关联上 |
| email / phone（contact） | `email_address` / `phone_number` 关联表 | **待实测** | 同上，join 查询 |
| opportunity_id / name | `opportunity.id` / `.name` | 高 | |
| stage | `opportunity.stage` | 高 | 缺省枚举 Prospecting / Qualification / Proposal / Negotiation / Closed Won / Closed Lost；安装向导是否本地化枚举值待实测 |
| amount / currency | `opportunity.amount` / `.amount_currency` | 中 | 列名 `amount_currency` 待实测 |
| probability | `opportunity.probability` | 高 | int 百分比 |
| close_date | `opportunity.close_date` | 高 | date |
| get_pipeline_summary | 无对应实体 | — | 由 opportunity 按 `assigned_user_id` 聚合（真实后端一条 GROUP BY），fixture 后端从明细现算——汇总与明细结构上不可能失同步 |

## 真实后端计划（路线图，未实现）

1. `docker/espocrm`：官方镜像 + MySQL 8，走完安装向导后 dump 上表涉及的真实
   schema，清掉「待实测」（对照 orangehrm-db-schema.md 的做法）。
2. 建 SELECT-only 账号，实现 `MySqlEspoCrmBackend implements EspoCrmBackend`
  （六个方法、连接池、参数化查询），环境变量探测对齐 orangehrm：
   `ESPOCRM_MYSQL_HOST / _USER / _PASSWORD`（凭据届时进部署侧 rsync 排除清单）。
3. 种子脚本灌 fixture 同口径演示数据，同一套 28 题（cases/espocrm.yaml）双后端
   全绿——复刻 HR 域「同一套题对真库也能跑」的验证性质。

## 诚实边界

- 本文档在真实实例核对前是**计划书不是实测记录**；上表「高」也只是对公开文档的
  置信度，不等于验证过。
- fixture 的演示 id（a001/c001/o001、e005/e007/e008）与真库 id 体系无关；行级
  规则只依赖 `owner_id` 的值与身份 `userId` 一致，这一契约由种子脚本负责成立。
