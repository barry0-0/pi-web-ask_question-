import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatAnswerScalar } from "../tool/format-answer.ts";
import type { QuestionAnswer, QuestionnaireResult } from "../tool/types.ts";

/**
 * Local-fork addition: the answered questionnaire is written back into the chat
 * transcript as a custom entry (never part of the LLM context), so the question and
 * what the user picked stay readable in the flow after the dialog closes.
 */
export const ASK_USER_QUESTION_ENTRY_TYPE = "ask-user-question";

/** Left gutter shared with the live questionnaire block (see `view/dialog-builder.ts`). */
const GUTTER = "┃ ";
const CONTINUATION = "  ";

export interface EntryAnswer {
	question: string;
	text: string;
	notes?: string;
}

export interface EntryData {
	answers: EntryAnswer[];
	cancelled: boolean;
	globalNote?: string;
}

/** Persisted shape: one compact answer per question, notes kept separately. */
export function buildEntryData(result: QuestionnaireResult): EntryData {
	return {
		answers: result.answers.map((a: QuestionAnswer) => ({
			question: a.question,
			text: formatAnswerScalar(a, "summary"),
			...(a.notes && a.notes.length > 0 ? { notes: a.notes } : {}),
		})),
		cancelled: result.cancelled === true,
		...(result.globalNote && result.globalNote.length > 0 ? { globalNote: result.globalNote } : {}),
	};
}

/**
 * Wrap `text` under the gutter. `firstPrefix` opens the first row, `CONTINUATION`
 * indents wrapped rows to the same column. Prefixes may carry SGR codes — the width
 * budget subtracts their visible columns only.
 */
function wrapRow(gutter: string, firstPrefix: string, text: string, width: number): string[] {
	const prefixWidth = Math.max(visibleWidth(firstPrefix), visibleWidth(CONTINUATION));
	const contentWidth = Math.max(1, width - visibleWidth(gutter) - prefixWidth);
	return wrapTextWithAnsi(text, contentWidth).map(
		(segment, index) => `${gutter}${index === 0 ? firstPrefix : CONTINUATION}${segment}`,
	);
}

/** Lazily laid out at render time so wrapping follows the terminal width. */
class EntryView implements Component {
	constructor(
		private readonly data: EntryData,
		private readonly theme: Theme,
	) {}

	render(width: number): string[] {
		const { theme, data } = this;
		const gutter = theme.fg("accent", GUTTER);
		const rows: string[] = [];

		for (const answer of data.answers) {
			rows.push(...wrapRow(gutter, "", theme.fg("dim", answer.question), width));
			rows.push(...wrapRow(gutter, theme.fg("accent", "→ "), answer.text, width));
			if (answer.notes) rows.push(...wrapRow(gutter, theme.fg("accent", "→ "), theme.fg("muted", answer.notes), width));
		}

		if (data.globalNote) {
			rows.push(...wrapRow(gutter, theme.fg("accent", "→ "), theme.fg("muted", data.globalNote), width));
		}

		if (data.cancelled) {
			const suffix = data.answers.length > 0 ? "（未提交）" : "";
			rows.push(...wrapRow(gutter, "", theme.fg("warning", `回答已取消${suffix}`), width));
		}

		return rows;
	}

	invalidate(): void {}
}

/** Renderer for `pi.registerEntryRenderer`: keeps the answered Q&A in the transcript. */
export function makeEntryComponent(entry: { data?: unknown }, theme: Theme): Component {
	const raw = (entry.data ?? {}) as Partial<EntryData>;
	return new EntryView(
		{
			answers: Array.isArray(raw.answers) ? raw.answers : [],
			cancelled: raw.cancelled === true,
			...(typeof raw.globalNote === "string" ? { globalNote: raw.globalNote } : {}),
		},
		theme,
	);
}
