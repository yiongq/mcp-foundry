#!/usr/bin/env bash
# 部署后冒烟：五探针。前两针探活与错误部署，后三针证明"守卫真的在守"。
# 任何 ❌ → 退出码 1。
#
# 用法：  BASE=https://foundry.yiongspace.com bash smoke.sh
#         BASE=http://127.0.0.1:3100 bash smoke.sh          （服务器本机）
#
# 令牌探针需要密钥来现签（服务器上从 .env 取）：
#         FOUNDRY_IDENTITY_SECRET=… bash smoke.sh
# 缺密钥时后三针跳过，前两针照跑。
set -u

BASE="${BASE:-https://foundry.yiongspace.com}"
fail=0

rpc='{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
H_JSON=(-H 'content-type: application/json' -H 'accept: application/json, text/event-stream')

pass() { printf '  \033[32m✅\033[0m %s\n' "$1"; }
bad() {
  printf '  \033[31m❌\033[0m %s\n' "$1"
  fail=1
}

# 1. 存活
code=$(curl -s -m 12 -o /dev/null -w '%{http_code}' "$BASE/healthz")
[[ "$code" == 200 ]] && pass "healthz -> 200" || bad "healthz -> $code (want 200)"

# 2. 伪造头必须被拒——这一针专抓"错误地以 demo 头模式上了公网"
code=$(curl -s -m 12 -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" "${H_JSON[@]}" \
  -H 'x-foundry-user: e004' -H 'x-foundry-role: hr_admin' -d "$rpc")
if [[ "$code" == 401 ]]; then
  pass "伪造 x-foundry-* 头 -> 401（token 模式生效）"
else
  bad "伪造 x-foundry-* 头 -> $code (want 401 — 服务可能在 demo 头模式，公网禁止！)"
fi

# 3-5. 令牌探针：需密钥现签
if [[ -z "${FOUNDRY_IDENTITY_SECRET:-}" ]]; then
  printf '  \033[33m—\033[0m 跳过令牌探针（未设 FOUNDRY_IDENTITY_SECRET）\n'
  exit "$fail"
fi

mint() { # role userId -> token
  docker compose exec -T -e FOUNDRY_IDENTITY_SECRET="$FOUNDRY_IDENTITY_SECRET" foundry-server \
    pnpm --filter @yiong/foundry-server run mint-token --user "$2" --role "$1" --ttl 300 2>/dev/null | tail -1
}

tools_of() { # token -> 逗号分隔的工具名
  curl -s -m 12 -X POST "$BASE/mcp" "${H_JSON[@]}" -H "authorization: Bearer $1" -d "$rpc" |
    grep -o '"name":"[a-z_]*"' | cut -d'"' -f4 | sort | paste -sd, -
}

emp=$(mint employee e002)
hr=$(mint hr_admin e004)

# 3. 员工令牌：工具面收窄，get_salary 必须不在
t=$(tools_of "$emp")
if [[ "$t" == "get_employee,get_leave_balance,list_employees" ]]; then
  pass "employee 令牌 -> 3 工具，无 get_salary"
else
  bad "employee 令牌 -> [$t] (want 3 工具且无 get_salary)"
fi

# 4. HR 令牌：多出 get_salary
t=$(tools_of "$hr")
if [[ "$t" == "get_employee,get_leave_balance,get_salary,list_employees" ]]; then
  pass "hr_admin 令牌 -> 4 工具，含 get_salary"
else
  bad "hr_admin 令牌 -> [$t] (want 4 工具含 get_salary)"
fi

# 5. 篡改令牌提权必须作废
forged="${emp%.*}.$(printf 'x%.0s' {1..43})"
code=$(curl -s -m 12 -o /dev/null -w '%{http_code}' -X POST "$BASE/mcp" "${H_JSON[@]}" \
  -H "authorization: Bearer $forged" -d "$rpc")
[[ "$code" == 401 ]] && pass "篡改签名 -> 401" || bad "篡改签名 -> $code (want 401)"

exit "$fail"
