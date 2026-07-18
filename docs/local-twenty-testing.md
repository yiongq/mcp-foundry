# 本地对着真 Twenty 测过再部署(解决"本地≠线上")

## 为什么需要这个

本地测试默认走 `FixtureBackend`(内存假 Twenty),线上走 `TwentyRestBackend`(真 Twenty REST)——
**两套实现,会静默漂移**(分页只读首页、UUID vs c001、错误码形状……都是漂移症状)。
所以"本地绿"证明不了"线上对"。

解法是补上中间缺的一层:**本地起一个真 Twenty,网关连它**,就和线上同一条代码路径了。

## 三层测试安全网(越往下越像生产)

| 层 | 跑什么 | 抓什么 | 频率 |
|---|---|---|---|
| ① 单测(秒) | `pnpm test`,含 `adapter-twenty/src/conformance.test.ts` | 两后端同契约 + 分页/退款 404 漂移护栏 | 每次改 |
| ② 集成(分钟) | 本地 Docker Twenty + seed + 网关连它,跑 demo/评测 | 真 REST 路径,本地=生产 | 改 Twenty 交互 / 上线前 |
| ③ 部署冒烟 | `smoke.sh` 打线上/staging | 401 / JWKS / 权限最后一道 | 每次部署后 |

日常小改走①;动了 Twenty 交互、或准备上线,走②;部署后走③。

## 第②层:本地真 Twenty 的完整流程

```
  1. 起本地 Twenty
        │  pnpm twenty:up                     # docker-compose.twenty.yml → http://localhost:3000
        ▼
  2. 一次性初始化(首次)
        │  浏览器进 localhost:3000 建工作区 → Settings→API&Webhooks 拿 API key
        │  建自定义对象 Order(name/email/lastFour/amountPaid/repCode),见 docs/twenty-notes.md
        ▼
  3. 灌 fixture 数据(与线上同源)
        │  TWENTY_API_URL=http://localhost:3000 TWENTY_API_KEY=<key> pnpm seed:twenty
        ▼
  4. 网关连本地真 Twenty(= 生产同路径)
        │  TWENTY_API_URL=http://localhost:3000 TWENTY_API_KEY=<key> TWENTY_OWNER_FIELD=repCode \
        │    pnpm --filter @yiong/foundry-server serve
        ▼
  5. 跑 demo / 端到端  ──红──► 修
        │绿
        ▼
  6. 按 DEPLOY-CHECKLIST 部署 VPS ──► smoke.sh 冒烟
        │
        ▼
  7. 收工:pnpm twenty:down
```

关键点:第 3–4 步让**本地网关吃的是真 Twenty REST**,和线上唯一的区别只剩"哪台 Twenty",行为不再分叉。

## seed 脚本也用于"别手改线上"

`packages/adapter-twenty/bin/seed-twenty.ts` 以 `FIXTURE_*` 为唯一数据源,通过 Twenty REST 灌
companies / people / opportunities / orders。**本地和线上都用它** → 数据同源;想改演示数据就改
`FIXTURE_*` 再重播,而不是手动改生产记录(见"别直接改线上数据"—`docs/verification-notes.md` 第五节)。

> 幂等性由 Twenty 侧决定:重复跑会产生重复记录,重播前先清空工作区。

## 鉴权也要 parity

本地默认是 demo 头模式(未签名,不能用来验证"防自批"这类身份不变量)。要贴近生产,本地也可跑
签名身份:`pnpm --filter @yiong/foundry-server run keygen` 生成 ES256 密钥对,设
`FOUNDRY_IDENTITY_JWKS=<本地 jwks 路径>` 起网关,再用 `mint-token` 签令牌测。
(生产已加护栏:设了 `FOUNDRY_ENV=production` 时缺签名身份直接拒绝启动,不会偷偷跑成头模式。)

## 注意

- `docker-compose.twenty.yml` 是**起点编排**,镜像 tag / 环境变量以 [Twenty 官方自托管文档](https://twenty.com/developers/section/self-hosting/docker-compose)为准。
- 起 Twenty 会拉官方镜像、占几个容器,比 fixture 重——所以①单测仍是日常主力,②按需跑。
