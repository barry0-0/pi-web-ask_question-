#!/usr/bin/env bash
# Pi 开关启动自愈入口。由 launcher 在 start_service() 阶段调用。
#
# 流程：
#   1. 解析 npm 全局 pi-web（不依赖 ~/.local/bin 软链）。
#   2. 从快照恢复 ask 工具扩展文件，回读校验。
#   3. 服务已停时清理旧版安装目录，并把软链指向新版。
#   4. 对当前版本 chunk 重注入前端补丁。
#   5. 校验 chunk 版本与语法。
#   6. 补跑 npm 未执行的 postinstall。
#
# 任何缺口都写入 ~/Library/Logs/pi-web-switch.log 并发 macOS 通知。
# 启动器不因此中断服务启动。

set -uo pipefail

RUNTIME="$(cd "$(dirname "$0")" && pwd)"
LOG="$HOME/Library/Logs/pi-web-switch.log"
EXT="$HOME/.pi/agent/extensions/rpiv-ask-user-question"
SNAPSHOT="$RUNTIME/snapshot/rpiv-ask-user-question"
OLD_PIWEB="$HOME/.local/lib/node_modules/@agegr/pi-web"
OLD_LINK="$HOME/.local/bin/pi-web"
DEV_DEPLOY="$HOME/Desktop/工作/ask_question/tools/deploy.sh"
PORT=30141

log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "bootstrap: $*" >>"$LOG" 2>/dev/null; }
notify() {
	/usr/bin/osascript -e "display notification \"$1\" with title \"Pi 开关\"" >/dev/null 2>&1 || true
}
warn() { log "WARN $1"; notify "Pi 自愈告警：$1"; }
fail() { log "FAIL $1"; notify "Pi 自愈失败：$1"; exit 1; }
is_up() { curl -s -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/" >/dev/null 2>&1; }

# --capture 是手动维护入口：刷新开发目录真源并同步运行时副本。
if [ "${1:-}" = "--capture" ]; then
	[ -x "$DEV_DEPLOY" ] || fail "找不到 $DEV_DEPLOY"
	exec "$DEV_DEPLOY" --capture
fi

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

# ---- 1. 解析 npm 全局 pi-web ----
PIWEB_DIR=""
NPM_ROOT=""
for NPM in /opt/homebrew/bin/npm /usr/local/bin/npm "$HOME/.local/bin/npm"; do
	[ -x "$NPM" ] || continue
	ROOT=$("$NPM" root -g 2>/dev/null) || continue
	[ -f "$ROOT/@agegr/pi-web/package.json" ] || continue
	NPM_ROOT="$ROOT"
	PIWEB_DIR="$ROOT/@agegr/pi-web"
	break
done
[ -n "$PIWEB_DIR" ] || fail "未找到 npm 全局 pi-web"
VERSION=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1]))['version'])" \
	"$PIWEB_DIR/package.json" 2>/dev/null || echo unknown)
log "pi-web $VERSION @ $PIWEB_DIR"

# ---- 2. 恢复 ask 工具扩展 ----
# 用户改用 GitHub 插件安装后，旧扩展目录会被移走。此时不重建，避免重复注册。
restored=0
if [ ! -d "$EXT" ]; then
	log "扩展目录不存在，跳过恢复（可能已改用插件安装）"
elif [ -d "$SNAPSHOT" ]; then
	while IFS= read -r rel; do
		[ -n "$rel" ] || continue
		src="$SNAPSHOT/$rel"
		dst="$EXT/$rel"
		if [ ! -f "$dst" ] || ! cmp -s "$src" "$dst"; then
			if mkdir -p "$(dirname "$dst")" 2>/dev/null && cp "$src" "$dst" 2>/dev/null; then
				restored=$((restored + 1))
				log "恢复扩展文件 $rel"
			else
				warn "无法恢复扩展文件 $rel"
			fi
		fi
	done < <(cd "$SNAPSHOT" && find . -type f | sed 's|^\./||')
	bad=0
	while IFS= read -r rel; do
		[ -n "$rel" ] || continue
		cmp -s "$SNAPSHOT/$rel" "$EXT/$rel" || { bad=$((bad + 1)); log "回读不一致 $rel"; }
	done < <(cd "$SNAPSHOT" && find . -type f | sed 's|^\./||')
	[ "$bad" -eq 0 ] || warn "扩展快照回读有 $bad 个不一致"
else
	warn "扩展快照缺失，跳过恢复：$SNAPSHOT"
fi
log "扩展恢复 $restored 个文件"

# ---- 3. 清理旧版（仅服务已停时） ----
if [ "$PIWEB_DIR" != "$OLD_PIWEB" ] && [ -d "$OLD_PIWEB" ]; then
	if is_up; then
		log "服务运行中，跳过清理旧版 $OLD_PIWEB"
	else
		stamp=$(date '+%Y%m%d-%H%M%S')
		target="$HOME/.Trash/pi-web-legacy-$stamp"
		mkdir -p "$HOME/.Trash" 2>/dev/null || true
		if mv "$OLD_PIWEB" "$target" 2>/dev/null; then
			log "旧版已移到废纸篓 $target"
			newbin="$NPM_ROOT/@agegr/pi-web/bin/pi-web.js"
			if [ -L "$OLD_LINK" ] && [ -f "$newbin" ]; then
				ln -sfn "$newbin" "$OLD_LINK" 2>/dev/null \
					&& log "软链已指向 $newbin" \
					|| warn "软链更新失败 $OLD_LINK"
			fi
		else
			warn "旧版移到废纸篓失败：$OLD_PIWEB"
		fi
	fi
fi

# ---- 4. 重注入前端补丁 ----
APP_DIR="$PIWEB_DIR/.next/static/chunks/app"
[ -d "$APP_DIR" ] || fail "chunk 目录不存在 $APP_DIR"
[ -f "$RUNTIME/apply.py" ] || fail "运行时缺 apply.py"
[ -f "$RUNTIME/rich_dialog_web.js" ] || fail "运行时缺 rich_dialog_web.js"

if ! python3 "$RUNTIME/apply.py" --app-dir "$APP_DIR" --check >>"$LOG" 2>&1; then
	fail "apply.py --check 失败。pi-web 结构可能已变化，需新增 profile"
fi
if ! python3 "$RUNTIME/apply.py" --app-dir "$APP_DIR" >>"$LOG" 2>&1; then
	fail "apply.py 注入失败"
fi

# ---- 5. 校验落盘 ----
CHUNK=$(ls "$APP_DIR"/page-*.js 2>/dev/null | head -1)
[ -n "$CHUNK" ] || fail "找不到 page-*.js"
grep -q 'data-pw-version": "4"' "$CHUNK" || fail "chunk 缺少版本 4"
grep -q '__PI_WEB_RICH_QUESTION_START__' "$CHUNK" || fail "chunk 缺少补丁标记"
node --check "$CHUNK" >>"$LOG" 2>&1 || fail "chunk 语法校验失败"

# ---- 6. 补跑 npm 未执行的 postinstall ----
if [ -f "$PIWEB_DIR/bin/prepare-terminal.js" ]; then
	node "$PIWEB_DIR/bin/prepare-terminal.js" >>"$LOG" 2>&1 \
		|| log "prepare-terminal 跳过（不影响启动）"
fi

log "OK pi-web $VERSION, chunk=$(basename "$CHUNK"), 扩展恢复 $restored"
exit 0
