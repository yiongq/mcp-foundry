# EspoCRM 9.3 真实 DB Schema（只读 MySQL 适配器依据）

来源：`espocrm/espocrm:9` 镜像自动安装后的 `DESCRIBE` 实测（2026-07-16，版本 9.3.10，
共 138 张表）。本文件是 `packages/adapter-espocrm/src/mysql.ts` 要 join 的表结构，
仅列适配器用得到的列。种子数据见 [docker/espocrm/seed-demo-data.sql](../docker/espocrm/seed-demo-data.sql)。

## 主键与关联关系

```
account.id / contact.id / opportunity.id / user.id   ← varchar(17)，无外键约束
account.assigned_user_id      → user.id               （统一行结构的 owner_id）
contact.account_id            → account.id
contact.assigned_user_id      → user.id
opportunity.account_id        → account.id
opportunity.assigned_user_id  → user.id
account_contact (account_id, contact_id, role)        ← 联系人职务在这里，不在 contact 主表
entity_phone_number (entity_id, entity_type, phone_number_id, `primary`) → phone_number.id
entity_email_address (entity_id, entity_type, email_address_id, `primary`) → email_address.id
```

电话/邮箱**不在实体主表**：`phone_number.name` / `email_address.name` 存值，
`entity_*` 关联表按 `entity_type`（'Account' / 'Contact'）+ `primary = 1` 取主记录。

## 统一行结构 ← 表列映射

| 统一字段 | 来源列 | 备注 |
| --- | --- | --- |
| `account_id` | `account.id` | varchar(17)；演示数据直插可读 id（a001…） |
| `name`（account） | `account.name` | |
| `industry` | `account.industry` | varchar，UI 上是 enum，DB 无约束 |
| `owner_id` | `*.assigned_user_id` | 归一命名；行级规则只认这个字段 |
| `website` | `account.website` | |
| `phone`（account） | `phone_number.name` via `entity_phone_number('Account', primary=1)` | |
| `city` | `account.billing_address_city` | |
| `contact_id` | `contact.id` | |
| `name`（contact） | `last_name` + `first_name` 拼接 | 中文整名存 last_name（种子约定，姓在前） |
| `title`（contact） | `account_contact.role` | **contact 主表没有 title 列**（9.3.10 实测） |
| `email` | `email_address.name` via `entity_email_address('Contact', primary=1)` | |
| `phone`（contact） | `phone_number.name` via `entity_phone_number('Contact', primary=1)` | |
| `opportunity_id` | `opportunity.id` | |
| `stage` | `opportunity.stage` | varchar；缺省枚举 Prospecting / Qualification / Proposal / Negotiation / Closed Won / Closed Lost（metadata 实测） |
| `amount` | `opportunity.amount` | **double** |
| `currency` | `opportunity.amount_currency` | varchar(3) |
| `probability` | `opportunity.probability` | int（百分比） |
| `close_date` | `opportunity.close_date` | date；SQL 侧 `DATE_FORMAT '%Y-%m-%d'` 出字符串，不依赖驱动的日期序列化 |
| `owner_name`（业绩盘） | `user.last_name` + `user.first_name` 拼接 | 归属人不在 user 表时适配器退回 owner_id |

业绩盘（get_pipeline_summary）无对应实体：`opportunity` 按 `assigned_user_id`
GROUP BY 聚合，Closed Won 计赢单、Closed Lost 不计、其余在途——与 fixture 后端
同一口径。stage 列可空（DEFAULT 'Prospecting' 但无 NOT NULL），聚合前先
`COALESCE(stage, '')`——裸 `NULL NOT IN (...)` 会被 SUM 静默跳过，明细与汇总对不上账。

## 查询纪律（与 orangehrm 后端同款）

- 软删过滤：所有表都有 `deleted` tinyint，每个 join/where 都带 `deleted = 0`；
- **大小写不敏感 collation**：列是 `utf8mb4_unicode_ci`（实测；`utf8mb3` 只是
  表级 DEFAULT，没有任何列在用），id / industry / stage 比较一律
  `CAST(... AS BINARY)` 字节精确匹配——否则 `O001` 变造能命中 `o001` 行
  （评测 cr11 题），与 fixture 精确匹配语义不同构；
- 保留字加反引号：`primary`（关联表列）、`user`（表名）、`numeric` / `type` / `role`（种子脚本）；
- 每条查询显式 LIMIT；全部 SQL 静态字符串 + 参数占位；连接账号 SELECT-only（foundry_ro）。

## 与安装器的关系

镜像首次启动即自动建全表（环境变量安装，无 Web 向导）；种子脚本只 INSERT 业务行，
不动系统表。id 列无外键约束，直插可读 id 合法——「owner_id 的值 == 身份 userId」
这一行级规则契约由种子脚本负责成立。
