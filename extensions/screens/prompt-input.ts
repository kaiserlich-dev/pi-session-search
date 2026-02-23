import { matchesKey } from "@mariozechner/pi-tui";
import type { Theme, PromptScreenState, PromptAction } from "../types";
import { shortenProject } from "../types";
import { makeBox } from "../lib/render-helpers";

const BOX_WIDTH = 82;

/**
 * Handle prompt input screen input.
 * Returns a typed action for screen transitions (back, confirm).
 * Typing and backspace mutate state directly and return undefined.
 */
export function handlePromptInput(
	state: PromptScreenState,
	data: string,
): PromptAction | undefined {
	if (matchesKey(data, "escape")) {
		return { type: "back" };
	}

	if (matchesKey(data, "return")) {
		const prompt = state.customPrompt.trim() || undefined;
		return { type: "confirm", customPrompt: prompt };
	}

	if (matchesKey(data, "backspace")) {
		if (state.customPrompt.length > 0) {
			state.customPrompt = state.customPrompt.slice(0, -1);
		}
		return;
	}

	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		state.customPrompt += data;
		return;
	}

	return;
}

/**
 * Render the prompt input screen.
 */
export function renderPromptInput(
	state: PromptScreenState,
	width: number,
	theme: Theme,
): string[] {
	const innerW = width - 2;
	const { row, emptyRow, divider, topBorder, bottomBorder } = makeBox(innerW, theme);

	const dim = (s: string) => theme.fg("dim", s);
	const muted = (s: string) => theme.fg("muted", s);
	const accent = (s: string) => theme.fg("accent", s);
	const bold = (s: string) => theme.bold(s);

	const lines: string[] = [];
	const session = state.session;
	const actionLabel =
		state.pendingActionType === "newSession" ? "New + Context" : "Inject Here";

	lines.push(topBorder("Summary Focus"));
	lines.push(emptyRow());

	const projectStr = shortenProject(session.project, 40);
	lines.push(
		row(`  ${bold(accent("📂"))} ${accent(projectStr)}  ${dim(`→ ${actionLabel}`)}`),
	);

	lines.push(emptyRow());
	lines.push(divider());
	lines.push(emptyRow());

	const cursor = accent("│");
	const promptDisplay = state.customPrompt
		? `${state.customPrompt}${cursor}`
		: `${cursor}${muted("e.g. focus on the auth implementation decisions...")}`;
	lines.push(row(`  ${dim("✎")} ${promptDisplay}`));

	lines.push(emptyRow());
	lines.push(divider());
	lines.push(
		row(
			`${accent("enter")} ${dim("default summary")}  ${accent("type")} ${dim("+ enter for custom")}  ${accent("esc")} ${dim("back")}`,
		),
	);
	lines.push(bottomBorder());

	return lines;
}
