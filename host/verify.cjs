#!/usr/bin/env node
/*
 * 本地静态验证。不安装任何依赖，直接复用 pi-web 自带的 react / react-dom。
 * 覆盖：纯函数契约、__piRich 信封、SSR 渲染结构、9 项规范的结构性约束。
 * 交互行为（粘贴、文件选择、预览、⌘↵）只做代码断言，需浏览器人工走查。
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const { execFileSync } = require("child_process");

function piWebModules() {
	const roots = [];
	try {
		const root = execFileSync("npm", ["root", "-g"], {
			encoding: "utf8",
			timeout: 5000
		}).trim();
		if (root) roots.push(root);
	} catch {
		// npm 不可用时走常见安装目录。
	}
	roots.push(
		"/opt/homebrew/lib/node_modules",
		"/usr/local/lib/node_modules",
		path.join(process.env.HOME, ".local/lib/node_modules")
	);
	for (const root of [...new Set(roots)]) {
		const candidate = path.join(root, "@agegr/pi-web/node_modules");
		if (fs.existsSync(path.join(candidate, "react"))) return candidate;
	}
	throw new Error("未找到 pi-web 自带的 react / react-dom");
}

const PI_WEB_MODULES = process.env.PI_ASK_PI_WEB_MODULES || piWebModules();
const React = require(path.join(PI_WEB_MODULES, "react"));
const ReactDOM = require(path.join(PI_WEB_MODULES, "react-dom"));
const ReactDOMServer = require(path.join(PI_WEB_MODULES, "react-dom/server"));

const source = fs.readFileSync(path.join(__dirname, "rich_dialog_web.js"), "utf8");

/* 模块 61789 里 i=React, ty=react-dom；SSR 不跑 useEffect，document 只给占位。 */
global.i = React;
global.ty = ReactDOM;
/* 补丁源码用占位符，注入时由 apply.py 代入模块作用域变量名。 */
global.__PW_REACT__ = React;
global.__PW_REACT_DOM__ = ReactDOM;
global.document = {
	body: {},
	addEventListener() {},
	removeEventListener() {}
};
vm.runInThisContext(source, { filename: "rich_dialog_web.js" });

let failed = 0;
let total = 0;
function ok(cond, label) {
	total++;
	if (cond) {
		console.log("PASS  " + label);
	} else {
		console.error("FAIL  " + label);
		failed++;
	}
}

/* ---- 纯函数契约 ---- */
const options = [
	"1. 当前 Pi Web（推荐）\n改 .next 静态 chunk，无需重启 App",
	"2. Pi Desktop 补丁复核\n只检查已有 asar 补丁",
	"3. 两个宿主都做\n双份维护",
	"4. Type something."
];
ok(global.__PwDetectSentinel(options) === 3, "哨兵选项按形状识别（末项无换行）");
ok(global.__PwDetectSentinel(["只有一项"]) === -1, "单项 select 不误判为问卷");
ok(global.__PwDetectSentinel(["1. A\n说明", "2. B\n说明"]) === -1, "无哨兵的普通 select 不误判");
const flatOptions = ["全部符合", "部分符合", "仍是旧卡片", "Type something."];
ok(global.__PwDetectSentinel(flatOptions) === 3, "description 被压平时仍识别哨兵");
ok(global.__PwParseOption(flatOptions[0]).label === "全部符合", "压平选项按单行解析");

const parsed = global.__PwParseOption(options[0]);
ok(parsed.number === "1." && parsed.label === "当前 Pi Web（推荐）"
	&& parsed.desc === "改 .next 静态 chunk，无需重启 App",
	"选项拆成 label + description 两行");
ok(global.__PwParseOption("普通选项").plain === true, "普通选项按单行处理");
ok(global.__PwStrip("\x1b[31m标题\x1b[0m") === "标题", "ANSI 色序列清理");

/* ---- 路由保护：只有问卷启用富卡片 ---- */
ok(global.__PwIsQuestionRequest({ method: "select", options }) === true,
	"问卷 select 启用富卡片");
ok(global.__PwIsQuestionRequest({ method: "select", options: flatOptions }) === true,
	"description 压平的问卷仍启用富卡片");
ok(global.__PwIsQuestionRequest({ method: "select", options: ["只有一个"] }) === false,
	"单选项 select 保持宿主原始弹窗");
ok(global.__PwIsQuestionRequest({ method: "confirm", title: "确认" }) === false,
	"confirm 保持宿主原始弹窗");
ok(global.__PwIsQuestionRequest({
	method: "input", title: "选多个", placeholder: "1,3; custom answer"
}) === true, "多选 input 启用富卡片");
ok(global.__PwIsQuestionRequest({ method: "input", placeholder: "随便输入" }) === false,
	"其它扩展的 input 保持宿主原始弹窗");

/* ---- __piRich 信封 ---- */
const env = global.__PwBuildEnvelope(
	[{ name: "a.png", data: "iVBORw0KGgo=" }],
	{ option: options[0] }
);
ok(env.startsWith('{"__piRich":1'), "信封前缀满足 RICH_SELECTION_PREFIX");
const decoded = JSON.parse(env);
ok(decoded.attachments.length === 0 && decoded.attachmentsData.length === 1
	&& decoded.attachmentsData[0].data === "iVBORw0KGgo="
	&& decoded.option === options[0],
	"信封字段与 rpc-fallback.ts 对齐（裸 base64 + 原样 option 行）");
const envOther = JSON.parse(global.__PwBuildEnvelope([], { other: "自定义" }));
ok(envOther.other === "自定义" && envOther.attachmentsData.length === 0,
	"无附件时不走信封，other 字段可解析");

/* ---- SSR 渲染结构 ---- */
function render(request) {
	return ReactDOMServer.renderToStaticMarkup(
		React.createElement(global.__PwRichQuestion, {
			request,
			waitingCount: 1,
			onRespond() {}
		})
	);
}
const selectHtml = render({ id: "q1", method: "select", title: "[范围] 目标宿主？", options });
ok(selectHtml.includes('data-pw-card="1"'), "卡片渲染为普通 DOM 节点");
ok(selectHtml.includes('data-pw-version="4"'), "卡片带版本号 4，便于 DevTools 确认真源");
const flatHtml = render({ id: "q2", method: "select", title: "新卡片的显示是否符合规范？", options: flatOptions });
ok((flatHtml.match(/data-pw-option="/g) || []).length === 3,
	"纯 label 问卷渲染 3 个业务选项，不重复渲染哨兵");
ok(flatHtml.includes("仍是旧卡片") && flatHtml.includes('data-pw-other="1"'),
	"纯 label 问卷保留业务选项与「其他」输入框");
ok(!selectHtml.includes("position:absolute") && !selectHtml.includes("position:fixed"),
	"卡片无 absolute / fixed 定位（不遮挡最后一条消息）");
ok((selectHtml.match(/data-pw-option="/g) || []).length === 3,
	"3 个业务选项渲染，哨兵项不渲染为按钮");
ok(selectHtml.includes("当前 Pi Web（推荐）") && selectHtml.includes("改 .next 静态 chunk"),
	"选项 label 与 description 同时输出");
ok(selectHtml.includes('data-pw-other="1"') && selectHtml.includes('placeholder="其他"'),
	"「其他」内联输入框存在");
ok(selectHtml.includes('data-pw-submit="1"') && selectHtml.includes("提交"),
	"提交按钮存在");
ok(selectHtml.includes("选择图片") && selectHtml.includes('accept="image/*"'),
	"原生图片文件选择控件存在");
ok(selectHtml.includes("取消") && selectHtml.includes('title="⌘↵ 提交"'),
	"取消入口与 ⌘↵ 快捷键提示存在");
ok(selectHtml.includes('data-pw-selected="0"')
	&& selectHtml.includes('data-pw-other-active="0"'),
	"选项与「其他」都带互斥高亮状态位");
ok(/pwSetChoice\(\{ kind: "option"/.test(source)
	&& /pwSetChoice\(pwValue\.trim\(\)\.length > 0 \? \{ kind: "other" \} : null\)/.test(source),
	"输入「其他」会高亮该项并取消选项高亮");
ok(/pwPickOption\(pwIdx, pwRaw\);/.test(source)
	&& !/pwReply\(\{ option: pwRaw \}, pwRaw\)/.test(source),
	"点击选项只选中，不立即提交");

const inputHtml = render({
	id: "q2", method: "input", title: "选择多个", placeholder: "1,3; custom answer"
});
ok(inputHtml.includes('data-pw-other="1"') && inputHtml.includes('placeholder="1,3; custom answer"'),
	"普通 input 请求复用同一内联输入框");
ok((inputHtml.match(/data-pw-option="/g) || []).length === 0,
	"普通 input 请求不渲染选项按钮");

/* ---- 答后置底 ---- */
/* 模块加载时未定义 window，pwUseIsoLayoutEffect 已固定为 useEffect。
   这里补一个最小假 DOM，只验证纯函数的祖先查找与置底行为。 */
ok(typeof global.__PwScrollContainerToBottom === "function",
	"置底函数已导出到模块作用域");
global.window = {
	getComputedStyle(pwEl) { return { overflowY: pwEl.overflowY || "visible" }; }
};
const container = { overflowY: "auto", scrollHeight: 4200, scrollTop: 0, parentElement: null };
const middle = { overflowY: "visible", parentElement: container };
const cardNode = { parentElement: middle };
ok(global.__PwScrollContainerToBottom(cardNode) === true
	&& container.scrollTop === 4200,
	"向上跨过非滚动节点，把最近的可滚动祖先置底");
const plainChain = { overflowY: "visible", scrollHeight: 10, scrollTop: 3, parentElement: null };
ok(global.__PwScrollContainerToBottom({ parentElement: plainChain }) === false
	&& plainChain.scrollTop === 3,
	"无可滚动祖先时不改任何滚动位置");
delete global.window;
ok(/pwUseIsoLayoutEffect\)\(function \(\)/.test(source)
	&& /\[pwRequest && pwRequest\.id\]/.test(source),
	"置底 effect 只在 request.id 变化时执行");
ok(/requestAnimationFrame\(pwToBottom\)/.test(source)
	&& /cancelAnimationFrame\(pwFrame\)/.test(source),
	"rAF 二次校正并在卸载时取消");
ok(/ref: pwCardRef/.test(source), "卡片根节点绑定 ref");

/* ---- 代码级行为断言 ---- */
ok(/addEventListener\("paste",\s*pwOnPaste,\s*true\)/.test(source)
	&& /pwEvt\.stopImmediatePropagation/.test(source),
	"图片粘贴在 document 捕获阶段拦截，不写入聊天输入框");
ok(/onKeyDown: function \(pwEvt\) \{\s*\n\s*if \("Escape" === pwEvt\.key/.test(source)
	&& /pwEvt\.preventDefault\(\);\s*\n\s*pwEvt\.stopPropagation\(\);\s*\n\s*pwSubmit\(\);/.test(source)
	&& !/"data-pw-other": "1"[\s\S]{0,500}onKeyDown: function \(pwEvt\)/.test(source),
	"⌘/Ctrl+Enter 由卡片级监听提交，textarea 内 Enter 只换行");
ok(/\(0, __PwReactDom\.createPortal\)\(/.test(source) && /document\.body/.test(source),
	"仅图片预览 portal 到 body");
ok(/var __PwReactDom = __PW_REACT_DOM__;/.test(source)
	&& /__PW_REACT__\.createElement/.test(source),
	"模块作用域变量改为占位符，由注入器按结构推导后代入");
ok(/close|关闭预览/.test(source) && /stopImmediatePropagation/.test(source),
	"预览 Esc 用 stopImmediatePropagation 抢占宿主监听");
ok(/pwFilesRef\.current\.length === 0/.test(source),
	"无附件时回退纯字符串回答");
ok(/__PW_MAX_BYTES = 2 \* 1024 \* 1024/.test(source)
	&& /__PW_MAX_FILES = 4/.test(source),
	"附件上限：单张 2MB，最多 4 张");

/* ---- 多题导航、多选控件、必答校验与草稿回填 ---- */
const navQ1 = {
	id: "nav1", method: "select",
	title: "第一题？\n[Q 1/3 #abc12345]", options
};
const navQ2 = {
	id: "nav2", method: "select",
	title: "第二题？\n[Q 2/3 #abc12345] 输入 /back 返回上一题", options
};
const navQ3 = {
	id: "nav3", method: "select",
	title: "第三题？\n[Q 3/3 #abc12345] 输入 /back 返回上一题", options
};
const navMulti = {
	id: "navM", method: "select",
	title: "多选？\n[Q 2/3 #abc12345 M] 输入 /back 返回上一题", options
};

ok(global.__PwNavMeta(navQ1) !== null
	&& global.__PwNavMeta(navQ1).index === 0
	&& global.__PwNavMeta(navQ1).total === 3
	&& global.__PwNavMeta(navQ1).session === "abc12345"
	&& global.__PwNavMeta(navQ1).canBack === false
	&& global.__PwNavMeta(navQ1).multi === false,
	"进度标记解析：首题 1/3、单选、无回退");
ok(global.__PwNavMeta(navQ2).index === 1
	&& global.__PwNavMeta(navQ2).canBack === true
	&& global.__PwNavMeta(navQ2).multi === false,
	"进度标记解析：第二题可回退");
ok(global.__PwNavMeta(navMulti).multi === true,
	"M 标记识别为多选");
ok(global.__PwNavMeta({ method: "select", title: "普通标题", options }) === null,
	"无进度标记的普通请求不启用导航");
ok(global.__PwStripNav(navQ2.title) === "第二题？"
	&& !/输入 \/back|\[Q/.test(global.__PwStripNav(navQ2.title)),
	"进度标记从可见标题剥离");
ok(global.__PwStripNav(navMulti.title) === "多选？",
	"M 标记也从可见标题剥离");
ok(global.__PwStrip("\x1b[31m标题\x1b[0m\n[Q 2/3 #abc] x").indexOf("[Q 2/3") >= 0,
	"__PwStrip 只清 ANSI，保留标记供解析");

const navBackEnvelope = JSON.parse(global.__PwBuildEnvelope([], { nav: "back" }));
ok(navBackEnvelope.nav === "back"
	&& global.__PwBuildEnvelope([], { nav: "back" }).startsWith('{"__piRich":1'),
	"回退信封满足 RICH_SELECTION_PREFIX，nav=back");
const navMultiEnvelope = JSON.parse(global.__PwBuildEnvelope([], { selected: [0, 2], other: "补充" }));
ok(navMultiEnvelope.selected[0] === 0 && navMultiEnvelope.selected[1] === 2
	&& navMultiEnvelope.other === "补充",
	"多选信封带 selected 索引数组与 other 文本");

const navQ1Html = render(navQ1);
ok(navQ1Html.includes('data-pw-step="1/3"')
	&& !navQ1Html.includes('data-pw-back="1"')
	&& navQ1Html.includes('data-pw-next="1"'),
	"首题显示 1/3、下一题，无上一题");
const navQ2Html = render(navQ2);
ok(navQ2Html.includes('data-pw-step="2/3"')
	&& navQ2Html.includes('data-pw-back="1"')
	&& navQ2Html.includes("← 上一题")
	&& navQ2Html.includes("下一题 →"),
	"第二题显示 2/3 与上一题/下一题");
const navQ3Html = render(navQ3);
ok(navQ3Html.includes('data-pw-back="1"')
	&& !navQ3Html.includes('data-pw-next="1"')
	&& navQ3Html.includes('data-pw-submit="1"'),
	"末题显示上一题与提交，无下一题");
ok(!navQ2Html.includes("[Q 2/3") && !navQ2Html.includes("输入 /back"),
	"进度提示行不出现在卡片可见文案里");
ok((navQ1Html.match(/data-pw-mark="radio"/g) || []).length === 3,
	"单选渲染 3 个圆圈标记");
const navMultiHtml = render(navMulti);
ok((navMultiHtml.match(/data-pw-mark="checkbox"/g) || []).length === 3
	&& (navMultiHtml.match(/data-pw-control="checkbox"/g) || []).length === 3,
	"多选渲染 3 个方框标记");
ok(navQ2Html.includes('data-pw-disabled="1"'),
	"未答时下一题按钮禁用（必答校验）");

/* 草稿缓存：回填选项、勾选项与文本；换 session 立即清空。 */
const draftKey = global.__PwStripNav(navQ2.title).trim();
const multiKey = global.__PwStripNav(navMulti.title).trim();
global.__PW_NAV_CACHE.session = "abc12345";
global.__PW_NAV_CACHE.byTitle[draftKey] = {
	choice: { kind: "option", idx: 0, raw: options[0] }, selected: [], text: "草稿A", files: []
};
const cachedHtml = render(navQ2);
ok(cachedHtml.includes("草稿A")
	&& /data-pw-checked="1"/.test(cachedHtml)
	&& cachedHtml.includes('data-pw-disabled="0"'),
	"同一题重发时回填输入、选项高亮，提交按钮恢复可用");
global.__PW_NAV_CACHE.byTitle[multiKey] = {
	choice: null, selected: [0, 2], text: "", files: []
};
ok((render(navMulti).match(/data-pw-checked="1"/g) || []).length === 2,
	"多选回填两个勾选项");
const otherSession = Object.assign({}, navQ2, {
	id: "nav4", title: navQ2.title.replace("#abc12345", "#zz99aa11")
});
ok(!render(otherSession).includes("草稿A"), "新 session 清空上一轮问卷的草稿");
delete global.__PW_NAV_CACHE.byTitle[draftKey];
delete global.__PW_NAV_CACHE.byTitle[multiKey];

/* ---- 代码级行为断言：导航、控件、必答 ---- */
ok(/nav: "back"/.test(source) && /function pwBack\(\)/.test(source),
	"「← 上一题」只发 nav:back 信封");
ok(/pwSaveDraft\(\);/.test(source)
	&& /selected: pwSelected/.test(source)
	&& /__PW_NAV_CACHE\.byTitle\[pwKey\]/.test(source),
	"提交与回退前保存草稿，含勾选项");
ok(/selected: pwSelected, other: pwText/.test(source),
	"多选结果走 __piRich 信封，无附件也发");
ok(/function pwToggleMulti\(pwIdx\)/.test(source)
	&& /pwSetSelected\(function \(pwPrev\)/.test(source),
	"多选点击切换勾选，不立即提交");
ok(/if \(!pwCanSubmit\) return;/.test(source)
	&& /disabled: !pwCanSubmit/.test(source),
	"必答校验同时约束点击与按钮状态");
ok(/卡片级：选中选项后可直接提交并进入下一题/.test(source),
	"⌘↵ 提交入口在卡片级");
ok(!/pwIsReview|data-pw-review|复核答案/.test(source),
	"复核卡及相关渲染已移除");
ok(/__PW_NAV_CACHE\.session !== pwNav\.session/.test(source)
	&& /pwCached \? pwCached\.text/.test(source),
	"按 session 隔离缓存并回填文本");

console.log("");
if (failed) {
	console.error("验证失败 " + failed + " 项");
	process.exit(1);
}
console.log("静态验证全部通过：" + total + " 项。");
