#!/bin/sh
# CrossMini：从提交生成发布目录 ~/.local/share/cmap-control/<sha>，构建公网 WebUI，切换 current 并重启 launchd 服务。
# 用法：infra/launchd/deploy.sh [<commit>]（默认 HEAD）。前置文件见 docs/deploy-edge.md。
set -eu
REPO=$(cd "$(dirname "$0")/../.." && pwd)
SHA=$(git -C "$REPO" rev-parse --short=7 "${1:-HEAD}^{commit}")
ROOT=${CMAP_CONTROL_ROOT:-$HOME/.local/share/cmap-control}
NODE=${CMAP_NODE:-$(command -v node)}
BIN=$(dirname "$NODE")
EDGE=$HOME/.cmap/edge
REL=$ROOT/$SHA
DOMAIN=gui/$(id -u)
AGENTS=$HOME/Library/LaunchAgents

for f in api.env worker.env tunnel_ed25519 known_hosts; do
  test -f "$EDGE/$f" || { echo "缺少 $EDGE/$f，见 docs/deploy-edge.md" >&2; exit 1; }
done
# node_modules 从工作区克隆，依赖必须与发布提交一致
git -C "$REPO" diff --quiet "$SHA" -- package.json package-lock.json \
  || { echo "工作区 package.json / package-lock.json 与 $SHA 不一致，先切到一致的依赖再发布" >&2; exit 1; }

mkdir -p "$ROOT/logs" "$ROOT/work"
if [ ! -d "$REL" ]; then
  rm -rf "$REL.partial" && mkdir -p "$REL.partial"
  git -C "$REPO" archive "$SHA" | tar -x -C "$REL.partial"
  cp -c -R "$REPO/node_modules" "$REL.partial/node_modules"   # APFS 克隆，不占额外空间
  (cd "$REL.partial" && PATH="$BIN:$PATH" \
    VITE_CMAP_OIDC_ISSUER=https://cmap.spux.cn/auth/realms/cmap VITE_CMAP_OIDC_CLIENT_ID=cmap-web \
    "$BIN/npm" run build:web)
  mv "$REL.partial" "$REL"
fi
ln -sfn "$REL" "$ROOT/current"
echo "current -> $REL"

for svc in tunnel api worker backup backup-mirror; do
  label=com.cmap.$svc
  new=$AGENTS/$label.plist.new
  sed -e "s|__HOME__|$HOME|g" -e "s|__NODE__|$NODE|g" -e "s|__ROOT__|$ROOT|g" \
      -e "s|__PATH__|$BIN:/usr/bin:/bin:/usr/sbin:/sbin|g" "$REPO/infra/launchd/$label.plist" > "$new"
  plutil -lint -s "$new"
  loaded=no; launchctl print "$DOMAIN/$label" >/dev/null 2>&1 && loaded=yes
  if [ "$loaded" = yes ] && cmp -s "$new" "$AGENTS/$label.plist"; then
    rm "$new"
    # 隧道不随发布重启，定时备份不在发布时触发；API 与 Worker 切到新的 current
    case $svc in tunnel|backup|backup-mirror) ;; *) launchctl kickstart -k "$DOMAIN/$label" ;; esac
  else
    [ "$loaded" = yes ] && launchctl bootout "$DOMAIN/$label" && sleep 2
    mv "$new" "$AGENTS/$label.plist"
    launchctl bootstrap "$DOMAIN" "$AGENTS/$label.plist"
  fi
  echo "$label: 已启动"
done
