# OrangeHRM 演示环境

REST 模式联调用的真实 OrangeHRM Starter 5.x。W1 演示与 CI 默认走 fixture 模式，**不依赖**本目录。

## 启动

```bash
cd docker/orangehrm
docker compose up -d
# mysql 健康检查通过后 orangehrm 才会起，首次拉镜像 + 初始化约 2~5 分钟
open http://localhost:8080
```

## 首次安装向导（重要）

官方镜像**没有预置管理员账号**，首次访问会进入 Web 安装向导，账号在向导里自己设：

1. 选 **Fresh Installation**，接受 License；
2. Database 配置一步填（容器内互访用服务名，不是 localhost）：
   - Database Host: `mysql`，Port: `3306`
   - Database Name: `orangehrm`
   - 勾选/选择「使用已存在的空库」路径时用 `orangehrm` / `orangehrm_pw`；
     若向导要求有建库权限的账号，改用 `root` / `orangehrm_root`；
3. Admin 账号一步自设管理员，例如 `Admin` / `OrangeHrm@2026`（大小写敏感，登录用它）；
4. 完成后向导把 DB 配置写进容器内 `/var/www/html/lib/confs/Conf.php`——该目录已挂进
   `orangehrm_data` 卷，`docker compose restart` 不会丢；`down -v` 会连数据一起清掉、下次重走向导。

## REST 模式对接

适配器读到以下环境变量即自动切 REST 模式：

```bash
export ORANGEHRM_BASE_URL=http://localhost:8080
export ORANGEHRM_CLIENT_ID=<OAuth2 客户端 ID>
export ORANGEHRM_CLIENT_SECRET=<OAuth2 客户端密钥>
```

OAuth2 客户端在管理后台注册（Admin 菜单下，5.6+ 才重新提供 OAuth2）；client_credentials
授权类型是否可用**待实测**，端点与备选方案见 `docs/orangehrm-api-notes.md`。
对接前记得在 PIM 里录入与 fixture 同口径的 6 名员工（employee_id 填 e001~e006）。

## 资源占用

- 内存约 **1G**：MySQL 8 约 450MB + OrangeHRM(Apache/PHP) 约 350MB，安装期有峰值，宿主机预留 1G 以上；
- 磁盘：两个数据卷 `mysql_data` / `orangehrm_data`，全新安装约 1~2GB。

## 常用操作

```bash
docker compose ps            # 看健康状态（两个服务都应为 healthy）
docker compose logs -f orangehrm
docker compose down          # 停（保留数据卷）
docker compose down -v       # 停并清空数据（下次重走安装向导）
```

已知注意点：
- orangehrm 容器的 healthcheck 用了容器内 `curl`，若换镜像版本后报 unhealthy，先确认镜像里有 curl；
- 端口冲突时改 `ports: "8080:80"` 的宿主侧端口，并同步改 `ORANGEHRM_BASE_URL`。
