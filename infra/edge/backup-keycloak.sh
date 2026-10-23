#!/bin/sh
# qcl 上每日由 /etc/cron.d/cmap-edge-backup 以 root 执行：导出 Keycloak 库（pg_dump -Fc），保留最近 14 份。
# 目录 0700、文件 0600；含用户与口令哈希，只由 CrossMini 经 infra/edge/pull-backups.sh 拉回。
set -eu
DIR=${CMAP_EDGE_BACKUP_DIR:-/var/backups/cmap-edge}
KEEP=${CMAP_EDGE_BACKUP_KEEP:-14}
umask 077
mkdir -p "$DIR"
FILE="$DIR/keycloak-$(date -u +%Y%m%dT%H%M%SZ).dump"
trap 'rm -f "$FILE.partial"' EXIT
docker compose -f /opt/cmap-edge/docker-compose.yml exec -T keycloak-db pg_dump -U keycloak -Fc keycloak > "$FILE.partial"
test -s "$FILE.partial"
mv "$FILE.partial" "$FILE"
ls -1 "$DIR"/keycloak-*.dump | sort -r | tail -n +"$((KEEP + 1))" | xargs -r rm -f --
echo "$(date -u +%FT%TZ) $FILE $(wc -c < "$FILE") bytes"
