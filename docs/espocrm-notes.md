# EspoCRM 对接笔记（adapter-espocrm）

状态：**真实后端已实现并本地验证（2026-07-16，espocrm/espocrm:9 → 9.3.10）**。
fixture 与只读 MySQL 双后端跑同一套 CRM 题集（37 题，并入全量 86 题）均全绿；首版计划里的
「待实测」已全部用真库 `DESCRIBE`/metadata 清掉，实测结论沉淀在
[espocrm-db-schema.md](./espocrm-db-schema.md)，环境与种子见
[docker/espocrm](../docker/espocrm)。

## 为什么选 EspoCRM 当第二个域

- 开源（GPLv3）、PHP + MySQL、官方 docker 镜像（`espocrm/espocrm`），本地起真库的
  成本与 OrangeHRM 相当，「只读直连 MySQL（SELECT-only 账号）」这条已验证的路径
  照搬成功（且镜像支持环境变量自动安装，比 OrangeHRM 的向导/CLI 更省事）。
- REST 这条路 EspoCRM 比 OrangeHRM 友好：支持 API 用户 + `X-Api-Key` 头认证，
  无人值守 server-to-server 不需要 OAuth 授权码——**写工具（W9）走 REST 写通道**
  （`src/rest.ts` 的 `EspoCrmRestWriter`，读仍走 fixture/只读 MySQL，由 `withRestWrites`
  组合），映射待实测项见本文末尾。
- 实体模型干净：Account / Contact / Opportunity 覆盖「客户-联系人-商机」的最小
  CRM 叙事，销售阶段是缺省枚举（Prospecting…Closed Lost），不用自造词表。

## 首版计划的「待实测」——实测裁决（2026-07-16）

| 当时的疑问 | 实测结论 |
| --- | --- |
| 电话/邮箱在主表还是关联表 | **关联表**：`phone_number`/`email_address` + `entity_*` join，取 `primary=1` |
| contact 的职务字段在哪 | **`account_contact.role`**——contact 主表没有 title 列 |
| `amount_currency` 列名 | 确认，varchar(3)；`amount` 是 double、`probability` 是 int |
| stage 枚举是否被本地化 | 未本地化，DB 存英文枚举值，与 fixture 逐字一致 |
| id 格式 | varchar(17) 且无外键约束——种子直插可读 id（a001/o001/e007）合法 |
| （计划外的发现）collation | 列是 `utf8mb4_unicode_ci`（表级 DEFAULT 才是 utf8mb3），大小写不敏感——键值比较必须 `CAST(... AS BINARY)`，否则 O001 变造命中 o001（评测 cr11 题会抓） |

## 已实施：只读 MySQL 后端

- `packages/adapter-espocrm/src/mysql.ts`：六个方法、静态 SQL + 参数占位、显式
  LIMIT、`deleted = 0` 全覆盖、BINARY 精确匹配；连接账号 SELECT-only（foundry_ro），
  与 orangehrm 后端同一套三层只读纪律。
- 环境变量探测：`ESPOCRM_MYSQL_HOST / _USER / _PASSWORD`（库名缺省 espocrm、
  端口缺省 3306），优先级 backend 注入 > mode 显式指定 > 环境变量 > fixture。
- 验证记录：espocrm 单真库与 HR+CRM 双真库两种组合下全量题库全绿 ×3 重复、
  方差 0（2026-07-16 为 75/75；2026-07-17 题库两次扩容至 77、82，双真库复跑均全绿）；
  2026-07-18 审批闸门（W9）并入后 fixture 86/86 全绿——写路径的真库 REST 复验待做；
  ablation 四档数字与 fixture 完全一致——守卫行为与后端无关。

## 诚实边界

- 「已验证」指本地 docker 真库（种子数据 5 客户/5 联系人/5 商机口径），
  不是生产 EspoCRM，也不是大数据量；线上演示仍跑 fixture 后端。
- REST（X-Api-Key）写通道已实现但**未对真库实测**：字段映射按公开 API 文档整理，
  以下待实测——`createContact` 把中文整名塞进 `lastName`（EspoCRM `name` 是 first+last
  拼接，整名入 last 显示不走样，但拆分检索会受影响）；`title` 直接写 Contact 属性，
  而本库 schema 里联系人职务在 `account_contact.role`，REST 的 `title` 是否与之一致待验；
  多电话/多邮箱、非 primary 记录、软删恢复等边角未测——读侧适配器只取 primary 一条。
  改这些映射前先更新本节。
- `ESPOCRM_MYSQL_*` 凭据若上生产，须进部署侧 rsync 排除清单与 `.env`
  （对齐 DEPLOY-CHECKLIST 的既有纪律）；本目录 compose 里的密码仅本地演示用。
