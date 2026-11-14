#!/usr/bin/env node
/*
 * RPC 问卷步进器行为验证。不装依赖，直接 import 本地扩展的 TypeScript 源码。
 * 运行：node --experimental-strip-types verify-rpc.js
 *
 * 覆盖：相邻回退、答案覆盖、末题直接提交、无复核卡、单选/多选控件化、
 *       多选 selected 信封、必答重问、取消、单题、plain host 数字串路径、
 *       Pi GPUI 原生步进、宿主隔离、多选累加与回填。
 */
const path = require("path");
const { pathToFileURL } = require("url");

const EXT = process.env.PI_ASK_RPC_FALLBACK
	|| path.join(__dirname, "..", "rpc-fallback.ts");

let failed = 0;
let total = 0;
function ok(cond, label) {
	total++;
	if (cond) console.log("PASS  " + label);
	else {
		console.error("FAIL  " + label);
		failed++;
	}
}

function scriptedUi(steps) {
	const calls = [];
	let cursor = 0;
	function next(call) {
		calls.push(call);
		const step = steps[cursor++];
		if (!step) throw new Error("多出一次对话调用: " + JSON.stringify(call));
		if (step.kind !== call.kind) {
			throw new Error("调用类型不符: 期望 " + step.kind + " 实际 " + call.kind);
		}
		return typeof step.reply === "function" ? step.reply(call) : step.reply;
	}
	return {
		calls,
		get remaining() { return steps.length - cursor; },
		async select(title, options) {
			return next({ kind: "select", title, options });
		},
		async input(title, placeholder) {
			return next({ kind: "input", title, placeholder });
		}
	};
}

const BACK_ENVELOPE = JSON.stringify({
	__piRich: 1, attachments: [], attachmentsData: [], nav: "back"
});

function multiEnvelope(selected, other) {
	return JSON.stringify({
		__piRich: 1, attachments: [], attachmentsData: [], selected, other
	});
}

function questions(count, multi = false) {
	return Array.from({ length: count }, (_, i) => ({
		question: `问题 ${i + 1}？`,
		header: `题${i + 1}`,
		multiSelect: multi,
		options: [
			{ label: `选项 ${i + 1}A`, description: `说明 ${i + 1}A` },
			{ label: `选项 ${i + 1}B`, description: `说明 ${i + 1}B` }
		]
	}));
}

function allTitlesHaveMarker(calls, index, count) {
	const re = new RegExp(`\\[Q ${index}/${count} #[a-z0-9]+\\]`);
	return calls.every((c) => re.test(c.title));
}

async function main() {
	const { runRpcQuestionnaire } = await import(pathToFileURL(EXT).href);
	// 本测试进程常驻 Pi GPUI 环境。先清除宿主标记，保证既有场景走默认 plain 路径。
	const savedBundle = process.env.__CFBundleIdentifier;
	delete process.env.__CFBundleIdentifier;

	/* 场景 1：答 Q1 → 到 Q2 点回退 → 重选 Q1 → 再答 Q2 → 直接结束 */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options[0] },
			{ kind: "select", reply: BACK_ENVELOPE },
			{ kind: "select", reply: (c) => c.options[1] },
			{ kind: "select", reply: (c) => c.options[0] }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(2) });
		ok(result.cancelled === false && result.answers.length === 2, "场景1：两份答案，未取消");
		ok(result.answers[0].questionIndex === 0 && result.answers[0].answer === "选项 1B",
			"场景1：回退后 Q1 答案被覆盖为新选项");
		ok(result.answers[1].questionIndex === 1 && result.answers[1].answer === "选项 2A",
			"场景1：Q2 答案保留");
		ok(ui.calls.length === 4, "场景1：调用序列为 Q1/Q2/Q1/Q2，共 4 次，无复核卡");
		ok(ui.calls.every((c) => !/复核答案/.test(c.title)), "场景1：不再出现复核卡标题");
		ok(ui.calls.every((c) => !/ M\]/.test(c.title)), "场景1：单选题目标记不含 M");
		ok(new Set(ui.calls.map((c) => (c.title.match(/#([a-z0-9]+)\]/) || [])[1])).size === 1,
			"场景1：同一会话标记在整份问卷内一致");
		ok(allTitlesHaveMarker(ui.calls.slice(0, 1), 1, 2)
			&& allTitlesHaveMarker(ui.calls.slice(2, 3), 1, 2)
			&& allTitlesHaveMarker(ui.calls.slice(1, 2), 2, 2)
			&& allTitlesHaveMarker(ui.calls.slice(3, 4), 2, 2),
			"场景1：每次题目请求都带 [Q i/n #session] 进度标记");
	}

	/* 场景 2：Q2 取消 → 整份问卷取消，保留已答部分 */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options[0] },
			{ kind: "select", reply: undefined }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(2) });
		ok(result.cancelled === true && result.answers.length === 1, "场景2：取消返回已答部分，cancelled=true");
	}

	/* 场景 3：多选控件化，selected 信封 + 回退 */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: multiEnvelope([0], "") },
			{ kind: "select", reply: BACK_ENVELOPE },
			{ kind: "select", reply: multiEnvelope([1], "补充") },
			{ kind: "select", reply: multiEnvelope([0, 1], "") }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(2, true) });
		ok(result.cancelled === false && result.answers.length === 2, "场景3：多选回退后正常提交");
		ok(result.answers[0].kind === "multi"
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify(["选项 1B"])
			&& result.answers[0].answer === "补充",
			"场景3：Q1 被覆盖，selected 与 other 同时解析");
		ok(JSON.stringify(result.answers[1].selected) === JSON.stringify(["选项 2A", "选项 2B"]),
			"场景3：Q2 多项 selected 保留");
		ok(ui.calls.every((c) => c.kind === "select"), "场景3：多选不再用 input，全部是选项请求");
		ok(ui.calls.every((c) => / M\]/.test(c.title)), "场景3：多选标题带 M 标记");
		ok(ui.calls.every((c) => !/复核答案/.test(c.title)), "场景3：多选问卷无复核卡");
	}

	/* 场景 4：3 题，末题提交即结束 */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options[0] },
			{ kind: "select", reply: (c) => c.options[0] },
			{ kind: "select", reply: (c) => c.options[0] }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(3) });
		ok(result.cancelled === false && result.answers.length === 3 && ui.calls.length === 3,
			"场景4：末题提交即结束，不追加复核卡");
		ok(allTitlesHaveMarker(ui.calls.slice(2, 3), 3, 3), "场景4：末题标记为 3/3");
	}

	/* 场景 5：单题无复核，首题 /back 退化为自定义答案 */
	{
		const ui = scriptedUi([{ kind: "select", reply: "/back" }]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1) });
		ok(result.cancelled === false && result.answers.length === 1
			&& result.answers[0].answer === "/back",
			"场景5：首题无上一题，/back 退化为普通自定义答案");
		ok(ui.calls.length === 1, "场景5：单题不追加任何额外卡片");
	}

	/* 场景 6：多选空答案重问（必答兜底） */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: multiEnvelope([], "") },
			{ kind: "select", reply: multiEnvelope([0], "") }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1, true) });
		ok(result.cancelled === false && ui.calls.length === 2
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify(["选项 1A"]),
			"场景6：多选空答案重问，不取消整份问卷");
	}

	/* 场景 7：单选空答案重问（必答兜底） */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: "" },
			{ kind: "select", reply: (c) => c.options[0] }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1) });
		ok(result.cancelled === false && ui.calls.length === 2
			&& result.answers[0].kind === "option",
			"场景7：单选空答案重问，不取消整份问卷");
	}

	/* 场景 8：plain host 多选，点业务选项行 */
	{
		const ui = scriptedUi([{ kind: "select", reply: (c) => c.options[0] }]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1, true) });
		ok(result.cancelled === false
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify(["选项 1A"]),
			"场景8：未补丁宿主点选项行退化为单选提交");
	}

	/* 场景 9：plain host 多选，走「其他」哨兵输入数字串 */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options[2] },
			{ kind: "input", reply: "1,2; 自定义" }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1, true) });
		ok(result.cancelled === false
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify(["选项 1A", "选项 1B"])
			&& result.answers[0].answer === "自定义",
			"场景9：数字串 + 分号自定义文本解析为多选答案");
	}

	/* 场景 10：plain host 直接把数字串键入 select 框 */
	{
		const ui = scriptedUi([{ kind: "select", reply: "1,2; 补充" }]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1, true) });
		ok(result.cancelled === false
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify(["选项 1A", "选项 1B"])
			&& result.answers[0].answer === "补充",
			"场景10：select 框直接键入数字串也解析为多选答案");
	}

	/* 场景 11：默认宿主不追加原生步进行，pi-web 路径不变 */
	{
		const ui = scriptedUi([{ kind: "select", reply: (c) => c.options[0] }]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1) });
		ok(result.cancelled === false
			&& ui.calls[0].options.length === 3
			&& !ui.calls[0].options.includes("← 上一题")
			&& !ui.calls[0].options.includes("完成选择 →"),
			"场景11：默认宿主不追加原生步进行（pi-web 路径不变）");
	}

	/* 场景 12：pi-web 启动标记优先于 bridge 参数 */
	{
		const savedEnv = process.env.PI_WEB_NO_OPEN;
		const savedArgv = process.argv.slice();
		process.env.PI_WEB_NO_OPEN = "1";
		process.argv.push("/tmp/pi-gpui-bridge.ts");
		const ui = scriptedUi([{ kind: "select", reply: (c) => c.options[0] }]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1) });
		process.argv = savedArgv;
		if (savedEnv === undefined) delete process.env.PI_WEB_NO_OPEN;
		else process.env.PI_WEB_NO_OPEN = savedEnv;
		ok(result.cancelled === false
			&& ui.calls[0].options.length === 3
			&& !ui.calls[0].options.includes("← 上一题"),
			"场景12：PI_WEB_NO_OPEN=1 时即使带 bridge 也保持 pi-web 路径");
	}

	/* 场景 13：Pi GPUI 单选，上一题 + 沿用上次答案 */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options[0] },
			{ kind: "select", reply: (c) => c.options.find((o) => o === "← 上一题") },
			{ kind: "select", reply: (c) => c.options.find((o) => o === "沿用上次答案 →") },
			{ kind: "select", reply: (c) => c.options[1] }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(2) }, true);
		ok(result.cancelled === false
			&& result.answers.length === 2
			&& result.answers[0].answer === "选项 1A"
			&& result.answers[1].answer === "选项 2B"
			&& ui.calls[1].options.includes("← 上一题")
			&& ui.calls[2].options.includes("沿用上次答案 →")
			&& ui.calls[2].title.includes("上次：选项 1A")
			&& ui.remaining === 0,
			"场景13：Pi GPUI 单选可上一题、回填、沿用上次答案");
	}

	/* 场景 14：Pi GPUI 多选，□/☑ 累加后完成选择 */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options[0] },
			{ kind: "select", reply: (c) => c.options[1] },
			{ kind: "select", reply: (c) => c.options.find((o) => o === "完成选择 →") }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1, true) }, true);
		ok(result.cancelled === false
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify(["选项 1A", "选项 1B"])
			&& result.answers[0].answer === null
			&& ui.calls[0].options[0].includes("□ 选项 1A")
			&& ui.calls[1].options[0].includes("☑ 选项 1A")
			&& ui.calls[1].options[1].includes("□ 选项 1B")
			&& ui.calls[2].options[1].includes("☑ 选项 1B")
			&& ui.remaining === 0,
			"场景14：Pi GPUI 多选 □/☑ 累加后提交");
	}

	/* 场景 15：Pi GPUI 多选回退后回填勾选态 */
	{
		const qs = [
			questions(1, true)[0],
			{ ...questions(1, false)[0], question: "问题 2？", header: "题2" }
		];
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options[0] },
			{ kind: "select", reply: (c) => c.options.find((o) => o === "完成选择 →") },
			{ kind: "select", reply: (c) => c.options.find((o) => o === "← 上一题") },
			{ kind: "select", reply: (c) => c.options.find((o) => o === "沿用上次答案 →") },
			{ kind: "select", reply: (c) => c.options[0] }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: qs }, true);
		ok(result.cancelled === false
			&& result.answers.length === 2
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify(["选项 1A"])
			&& result.answers[1].answer === "选项 1A"
			&& ui.calls[3].options[0].includes("☑ 选项 1A")
			&& ui.calls[3].options.includes("沿用上次答案 →")
			&& ui.calls[3].title.includes("上次：选项 1A")
			&& ui.remaining === 0,
			"场景15：Pi GPUI 多选回退后回填勾选态");
	}

	/* 场景 16：Pi GPUI 多选自定义文本 */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options[2] },
			{ kind: "input", reply: "补充" },
			{ kind: "select", reply: (c) => c.options.find((o) => o === "完成选择 →") }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1, true) }, true);
		ok(result.cancelled === false
			&& result.answers[0].answer === "补充"
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify([])
			&& ui.remaining === 0,
			"场景16：Pi GPUI 多选经其他行输入自定义文本");
	}

	/* 场景 17：Pi GPUI 多选修答时重问当前题 */
	{
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options.find((o) => o === "完成选择 →") },
			{ kind: "select", reply: (c) => c.options[0] },
			{ kind: "select", reply: (c) => c.options.find((o) => o === "完成选择 →") }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1, true) }, true);
		ok(result.cancelled === false
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify(["选项 1A"])
			&& ui.calls.length === 3
			&& ui.remaining === 0,
			"场景17：Pi GPUI 多选修答时重问当前题");
	}

	/* 场景 18：__CFBundleIdentifier 正向判定 Pi GPUI */
	{
		process.env.__CFBundleIdentifier = "dev.pi-gpui.app";
		const ui = scriptedUi([
			{ kind: "select", reply: (c) => c.options[0] },
			{ kind: "select", reply: (c) => c.options.find((o) => o === "完成选择 →") }
		]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1, true) });
		delete process.env.__CFBundleIdentifier;
		ok(result.cancelled === false
			&& ui.calls[0].options.includes("完成选择 →")
			&& ui.calls[0].options[0].includes("□ 选项 1A")
			&& JSON.stringify(result.answers[0].selected) === JSON.stringify(["选项 1A"])
			&& ui.remaining === 0,
			"场景18：dev.pi-gpui.app 正向判定启用原生步进");
	}

	/* 场景 19：pi-web 桌面开关标记否决 */
	{
		const savedArgv = process.argv.slice();
		process.env.__CFBundleIdentifier = "local.pi.switch";
		process.argv.push("/tmp/pi-gpui-bridge.ts");
		const ui = scriptedUi([{ kind: "select", reply: (c) => c.options[0] }]);
		const result = await runRpcQuestionnaire(ui, { questions: questions(1, true) });
		process.argv = savedArgv;
		delete process.env.__CFBundleIdentifier;
		ok(result.cancelled === false
			&& ui.calls[0].options.length === 3
			&& !ui.calls[0].options.includes("完成选择 →"),
			"场景19：local.pi.switch 否决，pi-web 富卡片路径不变");
	}

	if (savedBundle === undefined) delete process.env.__CFBundleIdentifier;
	else process.env.__CFBundleIdentifier = savedBundle;

	console.log("");
	if (failed) {
		console.error("验证失败 " + failed + " 项");
		process.exit(1);
	}
	console.log("RPC 步进器行为验证全部通过：" + total + " 项。");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
