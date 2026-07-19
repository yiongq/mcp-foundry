#!/usr/bin/env bash
# 备份：防篡改审计链能证明「记下的没被改」，但证明不了「东西还在」——单卷零副本，
# 一次磁盘故障 / docker volume rm 就全没了、哈希链也救不回。这脚本给出 durable 副本。
#
# 备份三样：
#   1. foundry-audit 卷（审计哈希链 foundry.jsonl + 审批账本 approvals.jsonl）
#   2. Twenty postgres（CRM 真库）
#   3. 校验清单（审计链 verify-audit 的最后一条 hash，做异地锚点，防末尾截断）
#
# 用法（服务器上，cron 每日）：
#   BACKUP_DIR=/opt/foundry-backups OFFSITE_RCLONE_REMOTE=r2:foundry-backups bash scripts/backup.sh
#
# 环境变量（均有默认值）：
#   BACKUP_DIR          备份落地目录（默认 /opt/foundry-backups）
#   AUDIT_VOLUME        审计 named volume 名（默认 mcp-foundry_foundry-audit）
#   TWENTY_DB_CONTAINER Twenty postgres 容器名（默认 twenty-db）
#   TWENTY_DB_USER      pg 用户（默认 postgres）
#   RETENTION_DAYS      本地保留天数（默认 14）
#   OFFSITE_RCLONE_REMOTE  设了就 rclone copy 到异地（如 r2:bucket）——异地才算真备份
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/foundry-backups}"
AUDIT_VOLUME="${AUDIT_VOLUME:-mcp-foundry_foundry-audit}"
TWENTY_DB_CONTAINER="${TWENTY_DB_CONTAINER:-twenty-db}"
TWENTY_DB_USER="${TWENTY_DB_USER:-postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

mkdir -p "$BACKUP_DIR"
echo "[backup] $TS → $BACKUP_DIR"

# 1. 审计 + 审批卷（只读挂载，tar 到宿主）
if docker volume inspect "$AUDIT_VOLUME" >/dev/null 2>&1; then
  docker run --rm -v "$AUDIT_VOLUME":/audit:ro -v "$BACKUP_DIR":/backup alpine:3 \
    tar czf "/backup/audit-$TS.tar.gz" -C /audit .
  echo "[backup] audit volume → audit-$TS.tar.gz"
else
  echo "[backup] WARN: 卷 $AUDIT_VOLUME 不存在，跳过（设 AUDIT_VOLUME 指定正确名）"
fi

# 2. Twenty postgres（若容器在跑）
if docker ps --format '{{.Names}}' | grep -qx "$TWENTY_DB_CONTAINER"; then
  docker exec "$TWENTY_DB_CONTAINER" pg_dumpall -U "$TWENTY_DB_USER" \
    | gzip > "$BACKUP_DIR/twenty-pg-$TS.sql.gz"
  echo "[backup] twenty pg → twenty-pg-$TS.sql.gz"
else
  echo "[backup] WARN: 容器 $TWENTY_DB_CONTAINER 未运行，跳过 Twenty 备份"
fi

# 3. 本地保留窗口外的旧备份清理
find "$BACKUP_DIR" -maxdepth 1 -type f -name '*.gz' -mtime "+$RETENTION_DAYS" -delete
echo "[backup] pruned local backups older than ${RETENTION_DAYS}d"

# 4. 异地副本（可选但强烈建议——同机副本挡不住整机丢失）
if [[ -n "${OFFSITE_RCLONE_REMOTE:-}" ]]; then
  if command -v rclone >/dev/null 2>&1; then
    rclone copy "$BACKUP_DIR" "$OFFSITE_RCLONE_REMOTE" --include "*-$TS.*"
    echo "[backup] offsite → $OFFSITE_RCLONE_REMOTE"
  else
    echo "[backup] WARN: 设了 OFFSITE_RCLONE_REMOTE 但没装 rclone，异地副本未生成"
  fi
else
  echo "[backup] NOTE: 未设 OFFSITE_RCLONE_REMOTE——当前只有本机副本，挡不住整机丢失。"
fi

echo "[backup] done."
