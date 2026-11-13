import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { QuestionData } from "../tool/types.ts";

/**
 * Local-fork addition: chat mode.
 *
 * Hosts that drive pi over RPC (Pi Desktop and other headless clients) return
 * `undefined` from `ui.custom()` — see `dist/modes/rpc/rpc-mode.js` — so no
 * component can ever render inside the transcript there, and the native
 * select/input dialogs have no image channel. Instead of a popup, chat mode
 * posts the questions as a message in the conversation and lets the user answer
 * in the composer, where images attach natively.
 */

export const CHAT_PROMPT_CUSTOM_TYPE = "ask-user-question-prompt";

export function buildChatQuestionMarkdown(questions: readonly QuestionData[]): string {
	const blocks = questions.map((question, index) => {
		const heading = question.header ? `**${index + 1}. ${question.header}**` : `**${index + 1}.**`;
		const lines = [`${heading} ${question.question}`];
		question.options.forEach((option, optionIndex) => {
			const suffix = option.description ? ` — ${option.description}` : "";
			lines.push(`${optionIndex + 1}) ${option.label}${suffix}`);
		});
		lines.push(question.multiSelect ? "_Answer with the numbers you want, comma separated._" : "_Answer with one number, or reply in your own words._");
		return lines.join("\n");
	});
	return blocks.join("\n\n");
}

export function buildChatResultText(questions: readonly QuestionData[]): string {
	const count = questions.length;
	return [
		`Posted ${count} question${count === 1 ? "" : "s"} to the conversation (chat mode). The user answers in their next message.`,
		"",
		"Stop here: end your turn now, with no extra tool calls and no answers of your own.",
		"When the user replies, treat that message as the answer. They may attach images; read those files with `read` before deciding. Anything they leave out stays unanswered.",
		"",
		buildChatQuestionMarkdown(questions),
	].join("\n");
}

/**
 * Post the question block as a custom message so it lands in the conversation
 * flow. `display: true` keeps the block visible; `triggerTurn: false` avoids
 * starting a new agent turn. Hosts without custom-message support still show
 * the same text through the tool result.
 */
export function postChatQuestion(pi: ExtensionAPI, questions: readonly QuestionData[], toolCallId: string): void {
	try {
		pi.sendMessage(
			{
				customType: CHAT_PROMPT_CUSTOM_TYPE,
				content: buildChatQuestionMarkdown(questions),
				display: true,
				details: { toolCallId, questions },
			},
			{ triggerTurn: false },
		);
	} catch {
		// Host without custom-message support: the tool result carries the same text.
	}
}
