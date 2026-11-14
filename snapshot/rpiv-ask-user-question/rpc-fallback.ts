/**
 * RPC / dialog-primitive fallback for `ask_user_question`.
 *
 * The canonical TUI path (`ctx.ui.custom()`) renders a tabbed overlay that
 * needs a real terminal. RPC-mode hosts (the VSCode pendant, ACP clients such
 * as Zed or Paseo) report `hasUI: true` because pi's dialog sub-protocol
 * (`extension_ui_request`/`extension_ui_response`) works, but `ui.custom()`
 * resolves `undefined` without rendering anything (issue #78). `ui.select()`
 * and `ui.input()` ARE functional there — the host renders them natively — so
 * this module walks the questions sequentially with those primitives and
 * returns the same `QuestionnaireResult` shapes the TUI produces, feeding the
 * shared `buildQuestionnaireResponse` envelope.
 *
 * Parity trade-offs vs the TUI, inherent to the select/input API surface: no
 * side-by-side preview pane (previews are folded into the prompt title) and no
 * tabbed multi-question view (one dialog per question). `ui.select()` only returns
 * one string, so multi-select uses a `{"__piRich":1,"selected":[...]}` envelope on
 * patched hosts, a `□`/`☑` accumulation loop on Pi GPUI, and degrades to a single
 * choice on other plain hosts.
 *
 * Local fork: the walker is a stepper, not a one-way loop. Every title carries a
 * `[Q i/n #session M?]` progress marker. `M` marks a multi-select question. The
 * patched pi-web card reads it to show a step chip, radio/checkbox controls and
 * "← 上一题" / "下一题 →" buttons; back returns a `{"__piRich":1,"nav":"back"}`
 * envelope. Plain hosts type `/back` instead. Pi GPUI 0.2.x cannot type into a
 * select, so it gets explicit `← 上一题` / `完成选择 →` rows and a `□`/`☑`
 * accumulation loop. The last question submits directly — there is no review
 * card. The patched pi-web card path is unchanged.
 */

import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { displayLabel, t } from "./state/i18n-bridge.ts";
import type { QuestionAnswer, QuestionData, QuestionnaireResult, QuestionParams } from "./tool/types.ts";

/**
 * Canonical-English fallbacks; resolved through `t()` at dialog time so the
 * live locale applies (top-level `const x = t(...)` would bake load-time
 * English in — see i18n-bridge.ts). The sentinel row label comes from
 * `displayLabel("other")` — same source as the TUI row.
 */
const MULTI_SELECT_INSTRUCTIONS =
	'Enter the numbers of all that apply, comma-separated (e.g. "1,3"). Add "; custom answer" to include your own text, or type only custom text.';
const CUSTOM_ANSWER_TITLE = "Type your answer:";
const MULTI_SELECT_PLACEHOLDER = "1,3; custom answer";

/** Longest preview slice folded into a select title before truncation. */
const MAX_PREVIEW_CHARS = 600;

/** Plain-host back command. The patched card sends a `nav:"back"` envelope instead. */
const BACK_COMMAND = "/back";

/**
 * Pi GPUI native stepper labels. Only that host receives these rows.
 * `□` / `☑` are text markers, not native checkbox widgets.
 */
const NATIVE_BACK_LABEL = "← 上一题";
const NATIVE_FINISH_LABEL = "完成选择 →";
const NATIVE_REUSE_LABEL = "沿用上次答案 →";
const NATIVE_UNCHECKED = "□ ";
const NATIVE_CHECKED = "☑ ";

/**
 * Pi GPUI starts pi with `--extension .../pi-gpui-bridge.ts`. pi-web's launcher
 * sets PI_WEB_NO_OPEN=1 and never passes that bridge. Detection failure keeps
 * the original one-shot plain-host path, so pi-web stays byte-identical.
 */
function detectNativeStepHost(): boolean {
	if (process.env.PI_WEB_NO_OPEN === "1") return false;
	try {
		return process.argv.some((arg) => /pi-gpui-bridge\.ts$/i.test(arg));
	} catch {
		return false;
	}
}

/** Internal signal: the user asked to revisit the previous question. */
const NAV_BACK = Symbol("rpc.nav.back");
type AskOutcome = QuestionAnswer | undefined | typeof NAV_BACK;

/**
 * The dialog-primitive slice of `ExtensionUIContext` this walker needs.
 * Structural on purpose: the pinned pi 0.74 peer types predate `ctx.mode`,
 * and jiti transpiles without type-checking — `hasDialogUI` is the runtime
 * gate that makes the shape trustworthy.
 */
export type DialogUI = {
	select: (title: string, options: string[]) => Promise<string | undefined>;
	input: (title: string, placeholder?: string) => Promise<string | undefined>;
};

/** True when the host implements the select/input dialog primitives. */
export function hasDialogUI(ui: unknown): ui is DialogUI {
	const u = ui as Partial<Record<"select" | "input", unknown>> | null | undefined;
	return typeof u?.select === "function" && typeof u?.input === "function";
}

type Option = QuestionData["options"][number];

function formatOptionLine(option: Option, index: number): string {
	return `${index + 1}. ${option.label}\n${option.description}`;
}

/**
 * Extra channels a patched host can return next to the chosen option: a typed
 * answer, a skip request, and attachment paths. Plain hosts return bare strings,
 * so everything here is optional.
 */
type RichSelection = {
	option?: string;
	other?: string;
	value?: string;
	skip?: boolean;
	/** `back` rewinds the stepper; only the patched card emits it. */
	nav?: string;
	/** 0-based checked option indexes for a multi-select question. */
	selected?: number[];
	attachments: string[];
	/** Images pasted into the card; inline because the renderer cannot write files. */
	attachmentsData: ClipboardPayload[];
};

type ClipboardPayload = { name: string; data: string };

/** Envelope written by the patched Pi Desktop dialog (`{"__piRich":1,...}`). */
const RICH_SELECTION_PREFIX = '{"__piRich":1';

function parseRichSelection(raw: string): RichSelection | null {
	if (!raw.startsWith(RICH_SELECTION_PREFIX)) return null;
	try {
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (parsed.__piRich !== 1) return null;
		const attachments = Array.isArray(parsed.attachments)
			? parsed.attachments.filter((path): path is string => typeof path === "string")
			: [];
		const attachmentsData = Array.isArray(parsed.attachmentsData)
			? parsed.attachmentsData.flatMap((item) => {
					if (typeof item !== "object" || item === null) return [];
					const { name, data } = item as Record<string, unknown>;
					return typeof data === "string" && data.length > 0
						? [{ name: typeof name === "string" ? name : "pasted-image.png", data }]
						: [];
				})
			: [];
		const selected = Array.isArray(parsed.selected)
			? parsed.selected.filter((i): i is number => typeof i === "number" && Number.isInteger(i))
			: undefined;
		return {
			option: typeof parsed.option === "string" ? parsed.option : undefined,
			other: typeof parsed.other === "string" ? parsed.other : undefined,
			value: typeof parsed.value === "string" ? parsed.value : undefined,
			skip: parsed.skip === true,
			nav: typeof parsed.nav === "string" ? parsed.nav : undefined,
			selected,
			attachments,
			attachmentsData,
		};
	} catch {
		return null;
	}
}

function sniffExtension(bytes: Uint8Array): string {
	const b = bytes;
	if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return ".png";
	if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return ".jpg";
	if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return ".gif";
	if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46) return ".webp";
	if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return ".bmp";
	return ".png";
}

/**
 * Pasted images arrive inline as base64 (the renderer cannot write files). Decode
 * each into a temp file so the answer names a real path the model opens with
 * `read` — the same contract pi's own composer uses for pasted images.
 */
async function materializeAttachments(rich: RichSelection | null): Promise<string[]> {
	if (!rich) return [];
	const paths = [...rich.attachments];
	if (rich.attachmentsData.length === 0) return paths;
	const written = await Promise.all(
		rich.attachmentsData.map(async (item) => {
			try {
				const bytes = Buffer.from(item.data, "base64");
				if (bytes.byteLength === 0) return undefined;
				const path = join(tmpdir(), `pi-clipboard-${randomUUID()}${sniffExtension(bytes)}`);
				await writeFile(path, bytes);
				return path;
			} catch {
				return undefined;
			}
		}),
	);
	for (const path of written) if (path !== undefined) paths.push(path);
	return paths;
}

/**
 * Attachment paths ride inside the answer text: the model opens them with `read`,
 * the same convention pi's own composer uses for pasted images.
 */
function appendAttachments(text: string | null, attachments: readonly string[]): string | null {
	if (attachments.length === 0) return text;
	const list = attachments.join(" ");
	return text !== null && text.length > 0 ? `${text}\n附件：${list}` : `附件：${list}`;
}

/**
 * Parse a user-entered (or select-returned) "N…" token to a 0-based option
 * index. `parseInt` reads the leading digits of "2. B — b" as 2; NaN and
 * out-of-range fail the bounds check and return null.
 */
function parseIndex(token: string, count: number): number | null {
	const i = Number.parseInt(token, 10) - 1;
	return i >= 0 && i < count ? i : null;
}

/** Previews folded into the select title — RPC has no side-by-side pane. */
function buildPreviewBlock(question: QuestionData): string {
	const blocks = question.options.flatMap((o, i) =>
		o.preview && o.preview.length > 0
			? [`--- ${i + 1}. ${o.label} preview ---\n${o.preview.slice(0, MAX_PREVIEW_CHARS)}`]
			: [],
	);
	return blocks.length > 0 ? `\n\n${blocks.join("\n\n")}` : "";
}

/**
 * Progress marker appended to every RPC dialog title. It is plain text, so an
 * unpatched host shows a readable hint. The patched pi-web card parses it and
 * strips it from the visible title. `session` scopes the card's answer cache:
 * a new `ask_user_question` call clears drafts from the previous call.
 */
type NavMeta = { session: string; index: number; total: number; canBack: boolean; multi: boolean };

function buildNavLine(nav: NavMeta): string {
	const marker = `[Q ${nav.index + 1}/${nav.total} #${nav.session}${nav.multi ? " M" : ""}]`;
	return nav.canBack ? `${marker} 输入 ${BACK_COMMAND} 返回上一题` : marker;
}

function withNav(title: string, nav: NavMeta): string {
	return `${title}\n${buildNavLine(nav)}`;
}

/** Previous answer shown on a revisited Pi GPUI question. Data, not help text. */
function nativePreviousLine(previous?: QuestionAnswer): string {
	if (!previous) return "";
	const parts: string[] = [];
	if (previous.selected && previous.selected.length > 0) parts.push(previous.selected.join("、"));
	if (previous.answer) parts.push(previous.answer);
	const text = parts.filter((part, i) => parts.indexOf(part) === i).join("；");
	return text ? `\n上次：${text}` : "";
}

/** Pi GPUI title: clean marker line, no `/back` hint, optional previous answer. */
function withNativeNav(title: string, nav: NavMeta, previous?: QuestionAnswer): string {
	const marker = `[Q ${nav.index + 1}/${nav.total} #${nav.session}${nav.multi ? " M" : ""}]`;
	return `${title}\n${marker}${nativePreviousLine(previous)}`;
}

function isBackText(raw: string): boolean {
	return raw.trim().toLowerCase() === BACK_COMMAND;
}

/** One answer per question, in question order, even after a question is revisited. */
function collectAnswers(byIndex: ReadonlyMap<number, QuestionAnswer>): QuestionAnswer[] {
	return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, a]) => a);
}

/**
 * Stepper over the questions. Each question is one native dialog. Dismissing it
 * cancels the whole questionnaire (Esc in the TUI). `NAV_BACK` rewinds one step
 * without discarding answers already collected for later questions. A normal
 * answer advances one step; answering the last question ends the run immediately.
 */
export async function runRpcQuestionnaire(
	ui: DialogUI,
	params: QuestionParams,
	nativeStepper: boolean = detectNativeStepHost(),
): Promise<QuestionnaireResult> {
	const total = params.questions.length;
	const byIndex = new Map<number, QuestionAnswer>();
	const session = randomUUID().slice(0, 8);
	let qi = 0;

	for (;;) {
		if (qi >= total) return { answers: collectAnswers(byIndex), cancelled: false };
		const q = params.questions[qi];
		const header = q.header ? `[${q.header}] ` : "";
		const nav: NavMeta = {
			session,
			index: qi,
			total,
			canBack: qi > 0,
			multi: q.multiSelect === true,
		};
		const previous = byIndex.get(qi);
		const outcome = nav.multi
			? await askMultiSelect(ui, q, qi, header, nav, nativeStepper, previous)
			: await askSingleSelect(ui, q, qi, header, nav, nativeStepper, previous);
		if (outcome === undefined) return { answers: collectAnswers(byIndex), cancelled: true };
		if (outcome === NAV_BACK) {
			if (qi > 0) qi -= 1;
			continue;
		}
		byIndex.set(qi, outcome);
		qi += 1;
	}
}

/**
 * `undefined` means the user dismissed the option dialog (cancel the questionnaire).
 * `NAV_BACK` means the user asked to revisit the previous question.
 *
 * Hosts return the chosen option line, but some also let the user type a reply in
 * place of picking (T3 Code's "Type your own answer" box) and return that text
 * (#299). A reply is therefore read as: an offered line → that option; a bare
 * number → that option (hosts that return an index); a reply equal to an option
 * label → that option; any other non-empty text → the user's own answer, verbatim
 * — never a dismissal, and never "option N plus discarded text". Cancelling the
 * "Type something." follow-up returns to the options instead of cancelling the
 * whole questionnaire (#142), and that input repeats the option list so the user
 * can refer to it while typing (#194).
 */
async function askSingleSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
	nav: NavMeta,
	nativeStepper: boolean,
	previous?: QuestionAnswer,
): Promise<AskOutcome> {
	const userLines = q.options.map(formatOptionLine);
	const otherLine = `${q.options.length + 1}. ${displayLabel("other")}`;
	const options = [...userLines, otherLine];
	if (nativeStepper && nav.canBack) options.push(NATIVE_BACK_LABEL);
	if (nativeStepper && previous) options.push(NATIVE_REUSE_LABEL);
	const baseTitle = `${header}${q.question}${buildPreviewBlock(q)}`;
	const title = nativeStepper
		? withNativeNav(baseTitle, nav, previous)
		: withNav(baseTitle, nav);
	const customTitle = nativeStepper
		? withNativeNav(
				`${header}${q.question}\n\n${userLines.join("\n")}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`,
				nav,
				previous,
			)
		: withNav(
				`${header}${q.question}\n\n${userLines.join("\n")}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`,
				nav,
			);
	for (;;) {
		const chosen = await ui.select(title, options);
		if (chosen == null) return undefined;
		if (nav.canBack && isBackText(chosen)) return NAV_BACK;
		if (nativeStepper && chosen === NATIVE_BACK_LABEL && nav.canBack) return NAV_BACK;
		if (nativeStepper && chosen === NATIVE_REUSE_LABEL && previous) return previous;
		const rich = parseRichSelection(chosen);
		if (rich) {
			if (nav.canBack && rich.nav === "back") return NAV_BACK;
			if (nativeStepper && rich.option === NATIVE_BACK_LABEL && nav.canBack) return NAV_BACK;
			if (nativeStepper && rich.option === NATIVE_REUSE_LABEL && previous) return previous;
			const attachments = await materializeAttachments(rich);
			if (rich.skip) {
				return { questionIndex, question: q.question, kind: "custom", answer: appendAttachments(null, attachments) };
			}
			if (rich.other !== undefined) {
				return { questionIndex, question: q.question, kind: "custom", answer: appendAttachments(rich.other, attachments) ?? rich.other };
			}
			if (rich.option !== undefined) {
				const line = options.indexOf(rich.option);
				const option = line >= 0 ? q.options[line] : undefined;
				if (option) {
					return {
						questionIndex,
						question: q.question,
						kind: "option",
						answer: appendAttachments(option.label, attachments) ?? option.label,
						preview: option.preview && option.preview.length > 0 ? option.preview : undefined,
					};
				}
				return {
					questionIndex,
					question: q.question,
					kind: "custom",
					answer: appendAttachments(rich.option, attachments) ?? rich.option,
				};
			}
		}
		const reply = chosen.trim();
		// 空答案不当成取消：必答校验要求重问当前题。
		if (reply.length === 0) continue;
		const idx = resolveSingleSelectReply(chosen, reply, options, q);
		if (idx === undefined) return { questionIndex, question: q.question, kind: "custom", answer: reply };
		if (idx < q.options.length) {
			const o = q.options[idx];
			return {
				questionIndex,
				question: q.question,
				kind: "option",
				answer: o.label,
				preview: o.preview && o.preview.length > 0 ? o.preview : undefined,
			};
		}
		// "Type something." sentinel → free-text follow-up; cancelling it, or a blank reply (#301),
		// goes back to the options.
		const typed = await ui.input(customTitle, "");
		if (nav.canBack && typed != null && isBackText(typed)) return NAV_BACK;
		if (typed == null || typed.trim().length === 0) continue;
		return { questionIndex, question: q.question, kind: "custom", answer: typed };
	}
}

/** Option index for a select reply, or `undefined` when the reply is the user's own text. */
function resolveSingleSelectReply(
	chosen: string,
	reply: string,
	lines: readonly string[],
	q: QuestionData,
): number | undefined {
	const line = lines.indexOf(chosen);
	if (line >= 0) return line;
	if (/^\d+\.?$/.test(reply)) return parseIndex(reply, lines.length) ?? undefined;
	const label = q.options.findIndex((o) => o.label === reply);
	return label >= 0 ? label : undefined;
}

/** Parse "1,3; custom" into 0-based indexes + custom text. `null` means free text. */
function parseMultiInput(raw: string, count: number): { indexes: number[]; custom: string } | null {
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { indexes: [], custom: "" };
	const [selectionPart = "", ...customParts] = trimmed.split(";");
	const selection = selectionPart.trim();
	const custom = customParts.join(";").trim();
	const tokens = selection.split(/[,\s]+/).filter((tok) => tok.length > 0);
	if (tokens.some((tok) => !/^\d+\.?$/.test(tok))) return null;
	const mapped = tokens.map((tok) => parseIndex(tok, count));
	if (mapped.some((i) => i === null)) return null;
	return { indexes: mapped as number[], custom };
}

/** Build a multi answer. `null` means nothing was chosen or typed (re-ask). */
function buildMultiAnswer(
	q: QuestionData,
	questionIndex: number,
	indexes: readonly number[],
	custom: string,
	attachments: readonly string[],
): QuestionAnswer | null {
	const selected: string[] = [];
	for (const i of indexes) {
		const label = q.options[i]?.label;
		if (label && !selected.includes(label)) selected.push(label);
	}
	const text = custom.trim();
	const answer = appendAttachments(text.length > 0 ? text : null, attachments);
	if (selected.length === 0 && !answer) return null;
	return { questionIndex, question: q.question, kind: "multi", answer, selected };
}

/** `undefined` cancels the questionnaire; `NAV_BACK` revisits the previous question. */
async function askMultiSelect(
	ui: DialogUI,
	q: QuestionData,
	questionIndex: number,
	header: string,
	nav: NavMeta,
	nativeStepper: boolean,
	previous?: QuestionAnswer,
): Promise<AskOutcome> {
	const baseLines = q.options.map(formatOptionLine);
	const otherLine = `${q.options.length + 1}. ${displayLabel("other")}`;
	const baseTitle = `${header}${q.question}`;
	const title = nativeStepper
		? withNativeNav(baseTitle, nav, previous)
		: withNav(
				`${baseTitle}\n\n${baseLines.join("\n")}\n\n${t("rpc.multi_instructions", MULTI_SELECT_INSTRUCTIONS)}`,
				nav,
			);
	const otherPrompt = nativeStepper
		? withNativeNav(
				`${baseTitle}\n\n${baseLines.join("\n")}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`,
				nav,
				previous,
			)
		: withNav(
				`${baseTitle}\n\n${baseLines.join("\n")}\n\n${t("rpc.custom_answer_title", CUSTOM_ANSWER_TITLE)}`,
				nav,
			);

	// Non-native plain hosts keep the original one-shot path.
	if (!nativeStepper) {
		const options = [...baseLines, otherLine];
		for (;;) {
			const chosen = await ui.select(title, options);
			if (chosen == null) return undefined;
			if (nav.canBack && isBackText(chosen)) return NAV_BACK;
			const rich = parseRichSelection(chosen);
			if (nav.canBack && rich?.nav === "back") return NAV_BACK;
			const attachments = await materializeAttachments(rich);
			if (rich?.selected !== undefined) {
				const answer = buildMultiAnswer(q, questionIndex, rich.selected, rich.other ?? "", attachments);
				if (answer) return answer;
				continue;
			}
			const line = options.indexOf(chosen);
			if (line >= q.options.length) {
				const typed = await ui.input(otherPrompt, MULTI_SELECT_PLACEHOLDER);
				if (typed == null) continue;
				if (nav.canBack && isBackText(typed)) return NAV_BACK;
				const parsed = parseMultiInput(typed, q.options.length);
				const answer = buildMultiAnswer(
					q, questionIndex, parsed?.indexes ?? [], parsed ? parsed.custom : typed, attachments,
				);
				if (answer) return answer;
				continue;
			}
			if (line >= 0) {
				const answer = buildMultiAnswer(q, questionIndex, [line], "", attachments);
				if (answer) return answer;
				continue;
			}
			const parsedText = parseMultiInput(chosen, q.options.length);
			const answer = buildMultiAnswer(
				q, questionIndex, parsedText?.indexes ?? [], parsedText ? parsedText.custom : chosen, attachments,
			);
			if (answer) return answer;
		}
	}

	// Pi GPUI native stepper: re-issue select after each toggle.
	const selected: number[] = [];
	let custom = "";
	let attachments: string[] = [];
	if (previous?.selected) {
		for (const label of previous.selected) {
			const i = q.options.findIndex((o) => o.label === label);
			if (i >= 0 && !selected.includes(i)) selected.push(i);
		}
	}
	if (previous?.answer) custom = previous.answer;

	const toggle = (index: number) => {
		const at = selected.indexOf(index);
		if (at >= 0) selected.splice(at, 1);
		else selected.push(index);
	};
	const addIndexes = (indexes: readonly number[]) => {
		for (const i of indexes) if (!selected.includes(i)) selected.push(i);
	};

	for (;;) {
		const displayLines = q.options.map((o, i) =>
			formatOptionLine(
				{ ...o, label: `${selected.includes(i) ? NATIVE_CHECKED : NATIVE_UNCHECKED}${o.label}` },
				i,
			),
		);
		const options = [...displayLines, otherLine, NATIVE_FINISH_LABEL];
		if (nav.canBack) options.push(NATIVE_BACK_LABEL);
		if (previous) options.push(NATIVE_REUSE_LABEL);
		const chosen = await ui.select(title, options);
		if (chosen == null) return undefined;
		if (nav.canBack && isBackText(chosen)) return NAV_BACK;
		if (chosen === NATIVE_BACK_LABEL && nav.canBack) return NAV_BACK;
		if (chosen === NATIVE_REUSE_LABEL && previous) return previous;
		const rich = parseRichSelection(chosen);
		if (rich) {
			if (nav.canBack && rich.nav === "back") return NAV_BACK;
			if (rich.option === NATIVE_BACK_LABEL && nav.canBack) return NAV_BACK;
			if (rich.option === NATIVE_REUSE_LABEL && previous) return previous;
			attachments = await materializeAttachments(rich);
			if (rich.selected !== undefined) {
				const answer = buildMultiAnswer(q, questionIndex, rich.selected, rich.other ?? "", attachments);
				if (answer) return answer;
				continue;
			}
			if (rich.other !== undefined) custom = rich.other;
			if (rich.option !== undefined) {
				const line = displayLines.indexOf(rich.option);
				if (line >= 0) toggle(line);
				else if (!rich.option.startsWith(RICH_SELECTION_PREFIX)) custom = rich.option;
			}
			continue;
		}
		const line = displayLines.indexOf(chosen);
		if (line >= 0) {
			toggle(line);
			continue;
		}
		if (chosen === otherLine) {
			const typed = await ui.input(otherPrompt, MULTI_SELECT_PLACEHOLDER);
			if (typed == null) continue;
			if (nav.canBack && isBackText(typed)) return NAV_BACK;
			const parsed = parseMultiInput(typed, q.options.length);
			if (parsed) {
				addIndexes(parsed.indexes);
				if (parsed.custom) custom = parsed.custom;
			} else {
				custom = typed;
			}
			continue;
		}
		if (chosen === NATIVE_FINISH_LABEL) {
			const answer = buildMultiAnswer(q, questionIndex, selected, custom, attachments);
			if (answer) return answer;
			continue;
		}
		// Some hosts let the user type directly into the select box.
		const parsedText = parseMultiInput(chosen, q.options.length);
		if (parsedText) {
			addIndexes(parsedText.indexes);
			if (parsedText.custom) custom = parsedText.custom;
		} else {
			custom = chosen;
		}
	}
}
