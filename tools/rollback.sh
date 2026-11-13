#!/usr/bin/env bash
# 回滚 pi-web 富问卷卡片补丁。
#   ./rollback.sh                 恢复最近一次备份
#   ./rollback.sh --strip         就地剥离补丁（不依赖备份）
#   ./rollback.sh --list          列出备份
#   ./rollback.sh --strip --app-dir <dir>   指定新版安装目录
set -euo pipefail
cd "$(dirname "$0")"

BACKUP_DIR="../backups"
BUNDLE_DIR="$HOME/.local/lib/node_modules/@agegr/pi-web/.next/static/chunks/app"

case "${1:-}" in
  --strip)
    exec ./apply.sh --strip "${@:2}"
    ;;
  --list)
    ls -lht "$BACKUP_DIR"/page-*.js.bak-* 2>/dev/null || echo "无备份"
    exit 0
    ;;
  "")
    ;;
  *)
    echo "用法: ./rollback.sh [--strip|--list] [--app-dir <dir>]" >&2
    exit 2
    ;;
esac

LATEST=$(ls -t "$BACKUP_DIR"/page-*.js.bak-* 2>/dev/null | head -n 1 || true)
if [[ -z "$LATEST" ]]; then
  echo "FAIL: 没有备份。可改用 ./rollback.sh --strip" >&2
  exit 1
fi

TARGET="$BUNDLE_DIR/$(basename "$LATEST" | sed -E 's/\.bak-[0-9]{8}-[0-9]{6}.*$//')"
if [[ ! -f "$TARGET" ]]; then
  echo "FAIL: 目标 bundle 不存在: $TARGET" >&2
  echo "新版安装目录请用 --strip --app-dir <dir>" >&2
  exit 1
fi

cp "$LATEST" "$TARGET"
node --check "$TARGET"
echo "已恢复: $TARGET"
echo "来源  : $LATEST"
echo "下一步: 浏览器硬刷新（⌘⇧R）"
