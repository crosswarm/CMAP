#!/bin/sh
# launchd 每日执行（com.cmap.backup）：备份账本与 Temporal 库、拉回 qcl 的 Keycloak 备份到 ~/.cmap/backups。
# 主机外副本由随后的 com.cmap.backup-mirror 镜像到 iCloud Drive（不在这里做：TCC 按 launchd 程序授权，见该 plist）。
# 任一步失败都继续做完其余步骤，最后以非零退出，日志见 ~/.local/share/cmap-control/logs/backup*.log。
set -u
umask 077
failed=0

echo "== $(date -u +%Y-%m-%dT%H:%M:%SZ) 备份开始"
node scripts/backup-db.mjs || failed=1
sh infra/edge/pull-backups.sh || failed=1
exit "$failed"
