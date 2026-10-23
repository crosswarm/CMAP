#!/bin/sh
# 在 CrossMini 上执行：把 infra/edge 同步到 qcl 的 /opt/cmap-edge 并 docker compose up -d。
# /opt/cmap-edge/.env（0600）须已存在，见 docs/deploy-edge.md。realm 文件只在 realm 不存在时导入。
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
TARGET=${CMAP_EDGE_SSH:-qcl}
COPYFILE_DISABLE=1 tar --no-xattrs -C "$HERE" -cf - docker-compose.yml Caddyfile keycloak backup-keycloak.sh cmap-edge-backup.cron \
  | ssh -o IdentityAgent=none -o BatchMode=yes "$TARGET" 'set -e
sudo -n test -f /opt/cmap-edge/.env || { echo "/opt/cmap-edge/.env 不存在，见 docs/deploy-edge.md" >&2; exit 1; }
sudo -n tar -xf - -C /opt/cmap-edge --no-same-owner
sudo -n install -m 0644 -o root -g root /opt/cmap-edge/cmap-edge-backup.cron /etc/cron.d/cmap-edge-backup
compose="sudo -n docker compose -f /opt/cmap-edge/docker-compose.yml"
$compose up -d
# Caddyfile 是单文件挂载，解包换了 inode，必须重启容器才能读到新内容
$compose restart caddy
$compose ps'
