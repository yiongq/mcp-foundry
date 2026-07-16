# EspoCRM 演示环境

只读 MySQL 模式联调用的真实 EspoCRM 9.3。演示与 CI 默认走 fixture 模式，**不依赖**本目录。

## 启动 + 安装（镜像自动安装，无向导）

```bash
cd docker/espocrm
docker compose up -d
# 官方镜像按环境变量自动安装，mysql 健康检查通过后一两分钟内建全 138 张表
```

## 灌演示数据 + 建只读账号

```bash
# 1. 种子数据（3 销售身份 / 5 客户 / 5 联系人 / 5 商机，对齐 fixture 数值；
#    ⚠️ 必须带 utf8mb4，否则中文存坏——orangehrm 真库的实测教训）
docker exec -i espocrm-mysql-1 mysql --default-character-set=utf8mb4 \
  -uroot -pespocrm_root espocrm < seed-demo-data.sql

# 2. SELECT-only 适配器专用账号（只读纪律的数据库侧强制）
docker exec espocrm-mysql-1 mysql -uroot -pespocrm_root -e '
CREATE USER IF NOT EXISTS "foundry_ro"@"%" IDENTIFIED BY "foundry_ro_pw";
GRANT SELECT ON espocrm.* TO "foundry_ro"@"%";'
```

UI 登录 `admin / Foundry@2026`（http://127.0.0.1:8072）。种子直插的销售身份
（wangwu/sunqi/zhouba）没有设密码，仅作为商机归属人存在，不用于登录。

## 只读 MySQL 模式对接

适配器读到以下环境变量即自动切 MySQL 模式：

```bash
export ESPOCRM_MYSQL_HOST=127.0.0.1
export ESPOCRM_MYSQL_PORT=3308          # compose 只发布到 127.0.0.1:3308
export ESPOCRM_MYSQL_USER=foundry_ro
export ESPOCRM_MYSQL_PASSWORD=foundry_ro_pw
# 可选：ESPOCRM_MYSQL_DATABASE（缺省 espocrm）

# 全量评测直接打真库（可与 ORANGEHRM_MYSQL_* 同时设，双域双真库）
pnpm --filter @yiong/foundry-eval run eval --repeat 3 --ablation
# MCP server 挂真库
pnpm --filter @yiong/foundry-server run serve
```

## 实测要点（2026-07-16，espocrm/espocrm:9 → 9.3.10）

- 列 collation 是 `utf8mb4_unicode_ci`（大小写不敏感；表级 DEFAULT 才是 utf8mb3）——
  适配器全部键值比较走 `CAST(... AS BINARY)`，与 orangehrm 同一条纪律、同一个理由；
- 电话/邮箱在独立关联表（`entity_phone_number` / `entity_email_address`，取 `primary=1`），
  联系人职务在 `account_contact.role`——完整映射见 docs/espocrm-db-schema.md；
- id 列 varchar(17) 无外键约束，种子直插可读 id（a001/o001/e007）。

## 资源占用 / 常用操作

内存实测约 500MB（`docker stats`：MySQL 8 约 430MB + EspoCRM(Apache/PHP) 空载约
60MB，Web 访问时会升高）。端口 8072/3308 都只绑 127.0.0.1（8071/3307 已被
docker/orangehrm 占用）。

```bash
docker compose ps            # 两个服务都应为 healthy
docker compose logs -f espocrm
docker compose down          # 停（保留数据卷）
docker compose down -v       # 停并清空数据（下次自动重装 + 需重灌种子）
```
