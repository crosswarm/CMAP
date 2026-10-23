#!/bin/sh
# 在 CrossMini 上执行：把 qcl 的 Keycloak 备份拉回 ~/.cmap/backups/keycloak（0700），本地同样只留最近 14 份。
set -eu
TARGET=${CMAP_EDGE_SSH:-qcl}
DIR=${CMAP_EDGE_BACKUP_LOCAL_DIR:-$HOME/.cmap/backups/keycloak}
KEEP=${CMAP_BACKUP_KEEP:-14}
umask 077
mkdir -p "$DIR"
rsync -a -e "ssh -o IdentityAgent=none -o BatchMode=yes" --rsync-path="sudo -n rsync" "$TARGET:/var/backups/cmap-edge/" "$DIR/"
ls -1 "$DIR"/keycloak-*.dump | sort -r | tail -n +"$((KEEP + 1))" | while read -r old; do rm -f -- "$old"; done
ls -l "$DIR" | tail -n 3
