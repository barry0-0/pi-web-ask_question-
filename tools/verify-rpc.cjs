#!/usr/bin/env node
/*
 * RPC 问卷步进器行为验证。不装依赖，直接 import 本地扩展的 TypeScript 源码。
 * 运行：node --experimental-strip-types verify-rpc.js
 *
 * 覆盖：相邻回退、答案覆盖、末题直接提交、无复核卡、单选/多选控件化、
 *       多选 selected 信封、必答重问、取消、单题、plain host 数字串路径。
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
