#!/usr/bin/env bash
# pi-web 富问卷卡片注入入口。参数原样传给 host/apply.py。
set -euo pipefail
cd "$(dirname "$0")/../host"
exec python3 apply.py "$@"
