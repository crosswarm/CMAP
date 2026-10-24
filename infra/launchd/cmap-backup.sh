#!/bin/sh
# launchd 每日执行（com.cmap.backup）：备份账本与 Temporal 库、拉回 qcl 的 Keycloak 备份，
# 再把 ~/.cmap/backups 原样镜像到 iCloud Drive 作为主机外副本（Cross 2026-10-24 决定，不加密）。
# 任一步失败都继续做完其余步骤，最后以非零退出，日志见 ~/.local/share/cmap-control/logs/backup*.log。
set -u
umask 077
SRC=$HOME/.cmap/backups
DEST=${CMAP_BACKUP_MIRROR_DIR:-"$HOME/Library/Mobile Documents/com~apple~CloudDocs/CMAP-backups"}
failed=0

echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) 备份开始"
node scripts/backup-db.mjs || failed=1
sh infra/edge/pull-backups.sh || failed=1
mkdir -p "$DEST" && rsync -a --delete "$SRC/" "$DEST/" || failed=1
echo "主机外副本：$(find "$DEST" -type f | wc -l | tr -d ' ') 个文件 -> $DEST"
exit "$failed"
