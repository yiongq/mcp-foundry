# OrangeHRM 演示环境

只读 MySQL 模式联调用的真实 OrangeHRM Starter 5.7。演示与 CI 默认走 fixture 模式，**不依赖**本目录。

## 启动

```bash
cd docker/orangehrm
docker compose up -d
# mysql 健康检查通过后 orangehrm 才会起，首次拉镜像 + 初始化约 2~5 分钟
open http://127.0.0.1:8071
```

## 安装（推荐 CLI，免踩 Web 向导的 oxd 控件坑）

官方镜像没有预置管理员账号。Web 向导可用，但 CLI 更稳（2026-07-16 实测）：

```bash
# 1. 写安装配置——cli_install.php 只读它旁边的 cli_install_config.yaml，传参数没用
docker exec orangehrm-orangehrm-1 sh -c 'cat > /var/www/html/installer/cli_install_config.yaml <<EOF
database:
  hostName: mysql        # 容器内互访用服务名，不是 localhost
  hostPort: 3306
  databaseName: orangehrm
  privilegedDatabaseUser: root
  privilegedDatabasePassword: orangehrm_root
  useSameDbUserForOrangeHRM: y
  orangehrmDatabaseUser: ~
  orangehrmDatabasePassword: ~
  isExistingDatabase: y  # compose 已把库建好（空库）
  enableDataEncryption: n
organization:
  name: FoundryDemo
  country: CN
admin:
  adminUserName: Admin
  adminPassword: Foundry@2026
  adminEmployeeFirstName: Foundry
  adminEmployeeLastName: Admin
  workEmail: admin@example.com
  contactNumber: ~
  registrationConsent: false
license:
  agree: y
EOF
php /var/www/html/installer/cli_install.php'

# 2. 灌演示数据（6 人，对齐 fixture 数值；⚠️ 必须带 utf8mb4，否则中文存坏）
docker exec -i orangehrm-mysql-1 mysql --default-character-set=utf8mb4 \
  -uroot -porangehrm_root orangehrm < seed-demo-data.sql

# 3. 建 SELECT-only 适配器专用账号（只读纪律的数据库侧强制）
docker exec orangehrm-mysql-1 mysql -uroot -porangehrm_root -e '
CREATE USER IF NOT EXISTS "foundry_ro"@"%" IDENTIFIED BY "foundry_ro_pw";
GRANT SELECT ON orangehrm.* TO "foundry_ro"@"%";'
```

安装写入的 DB 配置在 `orangehrm_data` 卷里，`docker compose restart` 不丢；
`down -v` 连数据一起清、需重装。UI 登录 `Admin / Foundry@2026`（安装器创建的管理员
员工已被种子数据改造成演示花名册里的老李 e004——hr_admin 演示身份即系统管理员）；
中文界面在 Admin → Configuration → Localization 切 `zh_Hans_CN`（5.7 预置）。

## 只读 MySQL 模式对接（当前主线）

适配器读到以下环境变量即自动切 MySQL 模式（优先级高于 REST）：

```bash
export ORANGEHRM_MYSQL_HOST=127.0.0.1
export ORANGEHRM_MYSQL_PORT=3307        # compose 只发布到 127.0.0.1:3307
export ORANGEHRM_MYSQL_USER=foundry_ro
export ORANGEHRM_MYSQL_PASSWORD=foundry_ro_pw
# 可选：ORANGEHRM_MYSQL_DATABASE（缺省 orangehrm）/ ORANGEHRM_LEAVE_TYPE（缺省 年假）

# 全量评测直接打真库
pnpm --filter @yiong/foundry-eval run eval --repeat 3 --ablation
# MCP server 挂真库
pnpm --filter @yiong/foundry-server run serve
```

真库联调抓到过的三坑（都已在适配器/种子层修掉，记录备查）：

1. **中文双重编码**：容器内 mysql 客户端默认 latin1，灌数据必须 `--default-character-set=utf8mb4`；
2. **大小写不敏感 collation**：列是 `utf8mb3_general_ci`，`E002` 能命中 `e002` 行——适配器
   全部键值比较走 `CAST(... AS BINARY)` 字节精确匹配，对齐 fixture 语义；
3. **COLLATE 跨字符集**：`COLLATE utf8mb4_bin` 套不上 utf8mb3 列，所以用 BINARY 而非 COLLATE。

## REST 模式（存档，不走）

OrangeHRM OS 版 OAuth2 只启用 AuthCode + RefreshToken，服务对服务的 client_credentials
**不支持**（源码实测，见 `docs/orangehrm-api-notes.md`），故 REST 后端仅保留接线，不作主线。

## 资源占用

- 内存约 **1G**：MySQL 8 约 450MB + OrangeHRM(Apache/PHP) 约 350MB，安装期有峰值，宿主机预留 1G 以上；
- 磁盘：两个数据卷 `mysql_data` / `orangehrm_data`，全新安装约 1~2GB。

## 常用操作

```bash
docker compose ps            # 看健康状态（两个服务都应为 healthy）
docker compose logs -f orangehrm
docker compose down          # 停（保留数据卷）
docker compose down -v       # 停并清空数据（下次需重装 + 重灌种子）
```

已知注意点：
- orangehrm 容器的 healthcheck 用了容器内 `curl`，若换镜像版本后报 unhealthy，先确认镜像里有 curl；
- 端口冲突时改宿主侧端口（8071/3307），并同步改环境变量。注意本机 8080/8090 会被 ai-edge
  网关的 dual-stack 监听（`*:port` IPv6）盖住，macOS 下 `localhost` 优先走 IPv6 会打到网关而非
  容器——故一律显式绑 `127.0.0.1` 并用不冲突端口；
- Web 向导的 oxd 单选/复选框有 span 覆盖层拦截点击，自动化要点 label 文字不是 input（CLI 安装可绕开）。
