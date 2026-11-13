#!/usr/bin/env node
/*
 * 用真实卡片组件做 SSR 渲染，再用 Chrome headless 截图。
 * 数据是文档示例，不是生产数据。README 会注明。
 *
 * 运行：node tools/make-screenshots.js
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const PI_MODULES = path.join(
	process.env.HOME,
	".local/lib/node_modules/@agegr/pi-web/node_modules"
);
const React = require(path.join(PI_MODULES, "react"));
const ReactDOM = require(path.join(PI_MODULES, "react-dom"));
const ReactDOMServer = require(path.join(PI_MODULES, "react-dom/server"));

global.i = React;
global.ty = ReactDOM;
global.__PW_REACT__ = React;
global.__PW_REACT_DOM__ = ReactDOM;
global.document = { body: {}, addEventListener() {}, removeEventListener() {} };
vm.runInThisContext(
	fs.readFileSync(path.join(ROOT, "host/rich_dialog_web.js"), "utf8"),
	{ filename: "rich_dialog_web.js" }
);

const OUT = path.join(ROOT, "meta/screenshots");
const TMP = path.join(OUT, ".tmp");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
fs.mkdirSync(TMP, { recursive: true });

function render(request, draft) {
	global.__PW_NAV_CACHE.session = "a1b2c3d4";
	global.__PW_NAV_CACHE.byTitle = {};
	if (draft) {
		const key = global.__PwStripNav(request.title).trim();
		global.__PW_NAV_CACHE.byTitle[key] = draft;
	}
	return ReactDOMServer.renderToStaticMarkup(
		React.createElement(global.__PwRichQuestion, {
			request, waitingCount: 1, onRespond() {}
		})
	);
}

function html(body) {
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><style>
:root{--bg:#fff;--bg-panel:#f6f8fa;--border:#d8dee4;--text:#1f2328;--text-muted:#59636e;--text-dim:#818b98;--accent:#2563eb;--accent-contrast:#fff}
*{box-sizing:border-box}
body{margin:0;background:#eef1f5;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;padding:28px}
.chat{max-width:780px;margin:0 auto;background:var(--bg);border:1px solid var(--border);border-radius:12px;padding:6px 18px 18px;box-shadow:0 10px 32px rgba(16,24,40,.08)}
.msg{padding:14px 0 12px;font-size:13px;color:var(--text-muted);border-bottom:1px dashed var(--border);margin-bottom:2px}
.msg b{color:var(--text);font-weight:600}
</style></head><body><div class="chat">
<div class="msg"><b>你</b> &nbsp; 帮我确认这次改造的范围</div>
${body}</div></body></html>`;
}

function shot(name, body) {
	const page = path.join(TMP, name + ".html");
	const out = path.join(OUT, name + ".png");
	fs.writeFileSync(page, html(body), "utf8");
	execFileSync(CHROME, [
		"--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
		"--force-device-scale-factor=1", "--window-size=860,860",
		"--virtual-time-budget=2500", `--screenshot=${out}`, "file://" + page,
	], { stdio: "ignore", timeout: 30000 });
	console.log("生成", path.relative(ROOT, out));
}

const singleOptions = [
	"1. 只改 Pi Web\n改 .next 静态 chunk，不动扩展",
	"2. 两个宿主都做\nPi Web 与 Pi Desktop 同步维护",
	"3. 做成独立插件\n发布到 GitHub，安装即用",
	"4. Type something."
];
const multiOptions = [
	"1. 单选圆圈\n选项前显示 radio，选中态高亮",
	"2. 多选方框\n可勾选多项，点击切换",
	"3. 前后切题\n上一题 / 下一题与草稿回填",
	"4. 快捷键\n⌘↵ 提交并进入下一题",
	"5. Type something."
];
const navOptions = [
	"1. 直接发布\n推送到 main，安装即用",
	"2. 先本地验证\n跑完静态与行为验证再推送",
	"3. 暂不发布\n保留本地仓库",
	"4. Type something."
];

shot("01-single-select", render({
	id: "s1", method: "select",
	title: "[范围] 这次改造覆盖哪个宿主？\n[Q 1/3 #a1b2c3d4]",
	options: singleOptions
}, { choice: { kind: "option", idx: 0, raw: singleOptions[0] }, selected: [], text: "", files: [] }));

shot("02-multi-select", render({
	id: "s2", method: "select",
	title: "[验收] 需要覆盖哪些验收项？\n[Q 2/3 #a1b2c3d4 M] 输入 /back 返回上一题",
	options: multiOptions
}, { choice: null, selected: [0, 2], text: "", files: [] }));

shot("03-navigation", render({
	id: "s3", method: "select",
	title: "[交付] 交付方式？\n[Q 2/3 #a1b2c3d4] 输入 /back 返回上一题",
	options: navOptions
}, null));

fs.rmSync(TMP, { recursive: true, force: true });
