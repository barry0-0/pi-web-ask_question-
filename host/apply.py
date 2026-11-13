#!/usr/bin/env python3
"""幂等注入 pi-web 富问卷卡片。

用法：
    python3 apply.py --check          # 只校验，不写文件
    python3 apply.py                  # 备份 + 注入
    python3 apply.py --strip          # 移除补丁，恢复原状（保留备份）
    python3 apply.py --bundle <path>  # 指定 bundle
    python3 apply.py --app-dir <dir>  # 指定 chunks/app 目录

定位方式：按内容锚点查找 page-*.js，不硬编码 Next.js 构建哈希。

跨版本适配：不写死 minified 变量名。用结构正则从「官方原文」推导出
请求变量、对话框组件、消息列、react-dom 变量与注入锚点，再生成三处替换。
只要渲染结构不变，pi-web 升级改了变量名也能自动适配（0.15.x → 0.16.x
已验证）。结构本身变化时不猜测，直接中止并输出诊断。
"""

import argparse
import base64
import datetime
import glob
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "rich_dialog_web.js")
BACKUPS = os.environ.get("PI_ASK_BACKUP_DIR") or os.path.join(HERE, "backups")
NODE_BIN = os.environ.get("PI_ASK_NODE") or "node"
DEFAULT_APP_DIR = os.path.join(
    os.path.expanduser("~"),
    ".local/lib/node_modules/@agegr/pi-web/.next/static/chunks/app",
)

START = "/*__PI_WEB_RICH_QUESTION_START__*/"
END = "/*__PI_WEB_RICH_QUESTION_END__*/"
META_START = "/*__PW_META__:"

# ---- 结构正则：只依赖 React.createElement 的调用形状，不依赖变量名 ----
V = r"[\w$]+"
RE_DIALOG = re.compile(
    r"(?P<req>" + V + r")&&\(0,(?P<jsx>" + V + r")\.jsx\)\((?P<dlg>" + V + r")"
    r",\{request:(?P=req),waitingCount:(?P<wait>" + V + r"),onRespond:(?P<resp>" + V + r")\}"
    r",(?P=req)\.id\),"
)
RE_COLUMN = re.compile(
    r"!(?P<flag>" + V + r")&&\(0,(?P<jsx>" + V + r")\.jsxs\)\((?P=jsx)\.Fragment,"
    r"\{children:\[\(0,(?P=jsx)\.jsx\)\(\"div\",\{ref:(?P<scroll>" + V + r"),"
)
RE_TAIL = re.compile(
    r"\(0,(?P<jsx>" + V + r")\.jsx\)\(\"div\",\{ref:(?P<hidden>" + V
    + r"),\"aria-hidden\":\"true\"\}\)\]"
)
RE_PORTAL = re.compile(r"\(0,(?P<dom>" + V + r")\.createPortal\)\(")
RE_REACT_PAIR = re.compile(
    r"var\s+(?P<jsx>" + V + r")\s*=\s*n\(95155\)\s*,\s*(?P<react>" + V + r")\s*=\s*n\(12115\)"
)
RE_REACT = re.compile(r"var\s+(?P<react>" + V + r")\s*=\s*n\(12115\)")
RE_JSX = re.compile(r"var\s+(?P<jsx>" + V + r")\s*=\s*n\(95155\)")

# 兼容旧注入（无元数据）的回退。新注入都带元数据，不再依赖这些写死串。
LEGACY_PROFILES = [
    [
        (
            "eK&&(0,r.jsx)(d_,{request:eK,waitingCount:eV,onRespond:eX},eK.id),",
            'eK&&("confirm"===eK.method||!__PwIsQuestionRequest(eK))'
            "&&(0,r.jsx)(d_,{request:eK,waitingCount:eV,onRespond:eX},eK.id),",
        ),
        (
            '!nE&&(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)("div",{ref:tn,',
            '(!nE||(eK&&"confirm"!==eK.method&&__PwIsQuestionRequest(eK)))'
            '&&(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)("div",{ref:tn,',
        ),
        (
            '(0,r.jsx)("div",{ref:nM,"aria-hidden":"true"})]',
            '(0,r.jsx)("div",{ref:nM,"aria-hidden":"true"})'
            ',eK&&"confirm"!==eK.method&&__PwIsQuestionRequest(eK)'
            "&&(0,r.jsx)(__PwRichQuestion,{request:eK,waitingCount:eV,onRespond:eX},eK.id)]",
        ),
    ],
    [
        (
            "eV&&(0,r.jsx)(ck,{request:eV,waitingCount:eZ,onRespond:e0},eV.id),",
            'eV&&("confirm"===eV.method||!__PwIsQuestionRequest(eV))'
            "&&(0,r.jsx)(ck,{request:eV,waitingCount:eZ,onRespond:e0},eV.id),",
        ),
        (
            '!nT&&(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)("div",{ref:tr,',
            '(!nT||(eV&&"confirm"!==eV.method&&__PwIsQuestionRequest(eV)))'
            '&&(0,r.jsxs)(r.Fragment,{children:[(0,r.jsx)("div",{ref:tr,',
        ),
        (
            '(0,r.jsx)("div",{ref:nA,"aria-hidden":"true"})]',
            '(0,r.jsx)("div",{ref:nA,"aria-hidden":"true"})'
            ',eV&&"confirm"!==eV.method&&__PwIsQuestionRequest(eV)'
            "&&(0,r.jsx)(__PwRichQuestion,{request:eV,waitingCount:eZ,onRespond:e0},eV.id)]",
        ),
    ],
]


def fail(msg):
    print("FAIL: " + msg, file=sys.stderr)
    sys.exit(1)


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def exactly_one(pattern, text):
    hits = list(pattern.finditer(text))
    return hits[0] if len(hits) == 1 else None


def derive(text):
    """从官方原文推导注入参数。结构不匹配返回 None。"""
    m1 = exactly_one(RE_DIALOG, text)
    m2 = exactly_one(RE_COLUMN, text)
    m3 = exactly_one(RE_TAIL, text)
    if not (m1 and m2 and m3):
        return None

    jsx = m1.group("jsx")
    if m2.group("jsx") != jsx or m3.group("jsx") != jsx:
        return None
    doms = {m.group("dom") for m in RE_PORTAL.finditer(text)}
    if len(doms) != 1:
        return None

    react = None
    pair = exactly_one(RE_REACT_PAIR, text)
    if pair and pair.group("jsx") == jsx:
        react = pair.group("react")
    else:
        r = exactly_one(RE_REACT, text)
        j = exactly_one(RE_JSX, text)
        if r and j and j.group("jsx") == jsx:
            react = r.group("react")
    if not react:
        return None

    req, dlg, wait, resp = (
        m1.group("req"), m1.group("dlg"), m1.group("wait"), m1.group("resp")
    )
    flag, scroll, hidden = (
        m2.group("flag"), m2.group("scroll"), m3.group("hidden")
    )
    anchor = "function " + dlg + "(e){"
    if text.count(anchor) != 1:
        return None

    o1 = m1.group(0)
    r1 = (
        req + '&&("confirm"===' + req + '.method||!__PwIsQuestionRequest(' + req + '))'
        "&&(0," + jsx + ".jsx)(" + dlg + ",{request:" + req + ",waitingCount:" + wait
        + ",onRespond:" + resp + "}," + req + ".id),"
    )
    o2 = m2.group(0)
    r2 = (
        "(!" + flag + "||(" + req + '&&"confirm"!==' + req
        + ".method&&__PwIsQuestionRequest(" + req + ")))&&(0," + jsx + ".jsxs)("
        + jsx + ".Fragment,{children:[(0," + jsx + '.jsx)("div",{ref:' + scroll + ","
    )
    o3 = m3.group(0)
    r3 = (
        "(0," + jsx + '.jsx)("div",{ref:' + hidden + ',"aria-hidden":"true"}),'
        + req + '&&"confirm"!==' + req + ".method&&__PwIsQuestionRequest(" + req
        + ")&&(0," + jsx + ".jsx)(__PwRichQuestion,{request:" + req
        + ",waitingCount:" + wait + ",onRespond:" + resp + "}," + req + ".id)]"
    )
    pairs = [(o1, r1), (o2, r2), (o3, r3)]
    for original, _ in pairs:
        if text.count(original) != 1:
            return None

    return {
        "name": "auto",
        "anchor": anchor,
        "react": react,
        "jsx": jsx,
        "dom": doms.pop(),
        "pairs": pairs,
        "vars": {
            "req": req, "dlg": dlg, "wait": wait, "resp": resp,
            "flag": flag, "scroll": scroll, "hidden": hidden,
        },
    }


def find_bundle(explicit=None, app_dir=None):
    if explicit:
        if not os.path.isfile(explicit):
            fail("bundle 不存在: " + explicit)
        return explicit
    directory = app_dir or DEFAULT_APP_DIR
    candidates = sorted(glob.glob(os.path.join(directory, "page-*.js")))
    hits = []
    for path in candidates:
        try:
            text = open(path, encoding="utf-8").read()
        except (OSError, UnicodeError):
            continue
        if derive(strip_patch(text)) is not None:
            hits.append(path)
    if len(hits) != 1:
        fail("在 %s 定位到 %d 个可适配的 page-*.js（期望 1 个）。候选: %s"
             % (directory, len(hits), ", ".join(candidates) or "<无>"))
    return hits[0]


def extract_meta(block):
    i = block.find(META_START)
    if i < 0:
        return None
    j = block.find("*/", i)
    if j < 0:
        return None
    try:
        return json.loads(base64.b64decode(block[i + len(META_START):j]).decode("utf-8"))
    except Exception:
        return None


def strip_patch(text):
    """把已注入的补丁全部撤销，返回与官方构建一致的内容。"""
    meta = None
    if START in text and END in text:
        begin = text.find(START)
        stop = text.find(END) + len(END)
        meta = extract_meta(text[begin:stop])
        if stop < len(text) and text[stop] == "\n":
            stop += 1
        text = text[:begin] + text[stop:]
    elif START in text or END in text:
        fail("只找到半边标记，补丁处于半成品状态。请用 rollback.sh 恢复备份。")

    if meta and isinstance(meta.get("p"), list):
        pairs = [(o, r) for o, r in meta["p"]]
    else:
        # 旧注入没有元数据，用回退表反替换。
        pairs = None
        for profile in LEGACY_PROFILES:
            if all(text.count(repl) >= 1 for _, repl in profile):
                pairs = profile
                break
        if pairs is None:
            return text
    for original, patched in pairs:
        text = text.replace(patched, original)
    return text


def validate_base(base, derived):
    if START in base or END in base or "__PwRichQuestion" in base:
        fail("剥离后仍残留补丁内容，无法安全重做。请用 rollback.sh 恢复备份。")
    checks = [(derived["anchor"], "注入锚点 " + derived["anchor"])]
    checks += [(original, "替换锚点 #%d" % (i + 1))
               for i, (original, _) in enumerate(derived["pairs"])]
    for needle, label in checks:
        count = base.count(needle)
        if count != 1:
            fail("%s 出现 %d 次（期望 1 次）。片段: %r" % (label, count, needle[:70]))
    return checks


def node_check(text, label):
    """把内容写到临时文件交给 node --check，避免把坏 JS 写进 bundle。"""
    fd, tmp = tempfile.mkstemp(prefix="ask-question-", suffix=".js")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        result = subprocess.run([NODE_BIN, "--check", tmp],
                                capture_output=True, text=True)
        if result.returncode != 0:
            fail("%s 语法校验失败:\n%s" % (label, result.stderr.strip()[:600]))
    finally:
        os.unlink(tmp)


def build_patched(base, source, derived):
    meta = {"v": 4, "a": derived["anchor"], "p": derived["pairs"]}
    encoded = base64.b64encode(json.dumps(meta, separators=(",", ":")).encode("utf-8")).decode("ascii")
    block = START + "\n" + META_START + encoded + "*/\n" + source.rstrip("\n") + "\n" + END + "\n"
    patched = base.replace(derived["anchor"], block + derived["anchor"], 1)
    for original, replacement in derived["pairs"]:
        patched = patched.replace(original, replacement, 1)
    if patched.count(START) != 1 or patched.count(END) != 1:
        fail("注入后标记数量异常。")
    for _, replacement in derived["pairs"]:
        if patched.count(replacement) != 1:
            fail("注入后替换片段数量异常: %r" % replacement[:70])
    return patched


def rotate_backups():
    os.makedirs(BACKUPS, exist_ok=True)
    files = sorted(glob.glob(os.path.join(BACKUPS, "page-*.js.bak-*")))
    while len(files) > 3:
        os.unlink(files.pop(0))


def backup(path, text=None):
    """备份剥离后的官方原文，而不是当前（可能已注入的）磁盘内容。"""
    os.makedirs(BACKUPS, exist_ok=True)
    stamp = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    target = os.path.join(BACKUPS, os.path.basename(path) + ".bak-" + stamp)
    if os.path.exists(target):
        target += "-" + str(os.getpid())
    if text is None:
        shutil.copy2(path, target)
    else:
        with open(target, "w", encoding="utf-8") as fh:
            fh.write(text)
        shutil.copymode(path, target)
    rotate_backups()
    return target


def atomic_write(path, text):
    directory = os.path.dirname(path)
    fd, tmp = tempfile.mkstemp(prefix=".ask-question-", suffix=".js", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        shutil.copymode(path, tmp)
        os.replace(tmp, path)
    except BaseException:
        if os.path.exists(tmp):
            os.unlink(tmp)
        raise


def main():
    parser = argparse.ArgumentParser(description="pi-web 富问卷卡片幂等注入")
    parser.add_argument("--check", action="store_true", help="只校验，不写文件")
    parser.add_argument("--strip", action="store_true", help="移除补丁，恢复官方构建")
    parser.add_argument("--bundle", help="显式指定 page-*.js 路径")
    parser.add_argument("--app-dir", help="显式指定 chunks/app 目录")
    args = parser.parse_args()

    source = open(SOURCE, encoding="utf-8").read()
    node_check(source.replace("__PW_REACT_DOM__", "globalThis")
               .replace("__PW_REACT__", "globalThis"), "补丁源码 rich_dialog_web.js")

    bundle = find_bundle(args.bundle, args.app_dir)
    current = open(bundle, encoding="utf-8").read()
    base = strip_patch(current)
    derived = derive(base)
    if derived is None:
        fail("chunk 渲染结构不匹配。pi-web 可能换了 React 调用形状，需人工核对新 bundle。")

    checks = validate_base(base, derived)
    # 先替换长占位符，避免 __PW_REACT__ 命中 __PW_REACT_DOM__。
    source = (source.replace("__PW_REACT_DOM__", derived["dom"])
                    .replace("__PW_REACT__", derived["react"]))

    v = derived["vars"]
    print("推导      : auto req=%s dlg=%s react=%s jsx=%s dom=%s"
          % (v["req"], v["dlg"], derived["react"], derived["jsx"], derived["dom"]))
    print("bundle      : " + bundle)
    print("当前字节数  : %d (字符 %d)" % (os.path.getsize(bundle), len(current)))
    print("当前 sha256 : " + sha(current))
    print("剥离后 sha256: " + sha(base))
    print("唯一锚点校验: %d 项全部通过" % len(checks))
    print("补丁源码    : %d 字符, sha256 %s" % (len(source), sha(source)))

    if args.strip:
        if base == current:
            print("状态        : 未注入，无需剥离。")
            return
        if args.check:
            print("--check    : 将剥离补丁，不执行。")
            return
        node_check(base, "剥离结果")
        bk = backup(bundle, base)
        atomic_write(bundle, base)
        print("备份        : " + bk)
        print("状态        : 已剥离，恢复官方构建内容。")
        return

    patched = build_patched(base, source, derived)
    node_check(patched, "注入结果")

    print("注入后字节数: %d (字符 %d)" % (
        len(patched.encode("utf-8")), len(patched)))
    print("注入后 sha256: " + sha(patched))

    if args.check:
        print("--check    : 校验通过，未写入任何文件。"
              "结构不匹配时本脚本会直接中止。")
        return

    if patched == current:
        print("状态        : 已是目标版本，无需写入。")
        return

    bk = backup(bundle, base)
    atomic_write(bundle, patched)
    written = open(bundle, encoding="utf-8").read()
    if written != patched:
        fail("写入后内容不一致，请立即用 rollback.sh 恢复: " + bk)
    node_check(written, "落盘文件")
    print("备份        : " + bk)
    print("备份保留    : 最近 3 份")
    print("状态        : 注入完成，语法校验通过。")
    print("下一步      : 浏览器硬刷新（⌘⇧R）或 DevTools → Network → Disable cache 后刷新。")
    print("验证服务    : curl -s http://127.0.0.1:30141/_next/static/chunks/app/%s "
          "| grep -c __PI_WEB_RICH_QUESTION_START__" % os.path.basename(bundle))


if __name__ == "__main__":
    main()
