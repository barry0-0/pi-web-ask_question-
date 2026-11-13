#!/usr/bin/env bash
# 把仓库真源同步到运行时副本。
#
# 运行时副本放在 ~/.pi/agent/pi-web-bootstrap/，不在 macOS TCC 保护的
# Desktop 目录下。Pi 开关.app 的 launcher 只访问运行时副本。
#
#   ./deploy.sh             同步 + 回读 sha256 校验
#   ./deploy.sh --capture   先从仓库根目录刷新扩展快照，再同步
#
# 唯一真源：仓库根目录。运行时副本只由本脚本写入。

set -euo pipefail

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TOOLS_DIR/.." && pwd)"
DEV_SNAPSHOT="$ROOT/snapshot/rpiv-ask-user-question"
RUNTIME="$HOME/.pi/agent/pi-web-bootstrap"

# 从仓库根目录挑出扩展源码，排除补丁、脚本、文档与版本控制目录。
# index.ts 不进快照：旧扩展目录里的入口是上游版本，覆盖会引用不存在的 host/。
EXCLUDE='host|tools|meta|snapshot|backups|\.git|node_modules'

if [ "${1:-}" = "--capture" ]; then
	python3 - "$ROOT" "$DEV_SNAPSHOT" "$EXCLUDE" <<'PY'
import os, shutil, sys
root, dst, exclude = sys.argv[1], sys.argv[2], sys.argv[3].split("|")
if os.path.isdir(dst):
    shutil.rmtree(dst)
os.makedirs(dst)
count = 0
for base, dirs, files in os.walk(root):
    dirs[:] = [d for d in dirs if d not in exclude]
    for name in files:
        if name in (".gitignore", "AGENTS.md", "README.md", "package.json", "index.ts"):
            continue
        source = os.path.join(base, name)
        rel = os.path.relpath(source, root)
        target = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copy2(source, target)
        count += 1
bad = []
for base, dirs, files in os.walk(dst):
    for name in files:
        target = os.path.join(base, name)
        rel = os.path.relpath(target, dst)
        source = os.path.join(root, rel)
        if not os.path.isfile(source) or open(target, "rb").read() != open(source, "rb").read():
            bad.append(rel)
if bad:
    sys.exit("捕获后回读不一致: " + ", ".join(bad))
print("capture: %d 个文件，回读一致" % count)
PY
	shift
fi

[ -d "$DEV_SNAPSHOT" ] || { echo "FAIL: 快照缺失，先跑 ./deploy.sh --capture" >&2; exit 1; }
[ -f "$ROOT/host/apply.py" ] || { echo "FAIL: 缺 host/apply.py" >&2; exit 1; }
[ -f "$TOOLS_DIR/bootstrap.sh" ] || { echo "FAIL: 缺 tools/bootstrap.sh" >&2; exit 1; }

mkdir -p "$RUNTIME"
rm -rf "$RUNTIME/snapshot"
mkdir -p "$RUNTIME/snapshot"
cp -R "$DEV_SNAPSHOT" "$RUNTIME/snapshot/"

# launcher 调用 $RUNTIME/bootstrap.sh；apply.py 与其源码必须同目录。
cp "$TOOLS_DIR/bootstrap.sh" "$RUNTIME/bootstrap.sh"
cp "$ROOT/host/apply.py" "$ROOT/host/rich_dialog_web.js" "$RUNTIME/"
chmod +x "$RUNTIME/bootstrap.sh"

# 回读：仓库真源与运行时副本逐文件 sha256 比对。
python3 - "$ROOT" "$RUNTIME" <<'PY'
import hashlib, os, sys
root, run = sys.argv[1], sys.argv[2]
pairs = [
    ("host/apply.py", "apply.py"),
    ("host/rich_dialog_web.js", "rich_dialog_web.js"),
    ("tools/bootstrap.sh", "bootstrap.sh"),
]
for base, dirs, names in os.walk(os.path.join(root, "snapshot")):
    for name in names:
        rel = os.path.relpath(os.path.join(base, name), root)
        pairs.append((rel, rel))

def digest(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()

bad = []
for source_rel, target_rel in pairs:
    source = os.path.join(root, source_rel)
    target = os.path.join(run, target_rel)
    if not os.path.isfile(target) or digest(source) != digest(target):
        bad.append(target_rel)
if bad:
    sys.exit("FAIL: 副本不一致: " + ", ".join(bad))
print("deploy: %d 项回读一致 -> %s" % (len(pairs), run))
PY
