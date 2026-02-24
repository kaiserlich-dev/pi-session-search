import { matchesKey, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
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

	// Cursor movement
	if (matchesKey(data, "left")) {
		if (state.cursorPos > 0) state.cursorPos--;
		return;
	}

	if (matchesKey(data, "right")) {
		if (state.cursorPos < state.customPrompt.length) state.cursorPos++;
		return;
	}

	if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
		state.cursorPos = 0;
		return;
	}

	if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
		state.cursorPos = state.customPrompt.length;
		return;
	}

	// Alt+Backspace / Ctrl+W: delete word before cursor
	if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
		if (state.cursorPos === 0) return;
		const before = state.customPrompt.slice(0, state.cursorPos);
		const after = state.customPrompt.slice(state.cursorPos);
		let i = before.length;
		while (i > 0 && before[i - 1] === " ") i--;
		while (i > 0 && before[i - 1] !== " ") i--;
		state.customPrompt = before.slice(0, i) + after;
		state.cursorPos = i;
		return;
	}

	// Backspace: delete char before cursor
	if (matchesKey(data, "backspace")) {
		if (state.cursorPos > 0) {
			state.customPrompt =
				state.customPrompt.slice(0, state.cursorPos - 1) +
				state.customPrompt.slice(state.cursorPos);
			state.cursorPos--;
		}
		return;
	}

	// Delete: delete char after cursor
	if (matchesKey(data, "delete")) {
		if (state.cursorPos < state.customPrompt.length) {
			state.customPrompt =
				state.customPrompt.slice(0, state.cursorPos) +
				state.customPrompt.slice(state.cursorPos + 1);
		}
		return;
	}

	// Paste or single character: insert at cursor position
	if (data.length >= 1 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b")) {
		state.customPrompt =
			state.customPrompt.slice(0, state.cursorPos) +
			data +
			state.customPrompt.slice(state.cursorPos);
		state.cursorPos += data.length;
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
	const prefixStr = `  ${dim("✎")} `;
	const prefixW = 6; // "  ✎ " visible width
	const textW = innerW - prefixW - 2; // usable width for text per line

	if (!state.customPrompt) {
		lines.push(row(`${prefixStr}${cursor}${muted("e.g. focus on the auth implementation decisions...")}`));
	} else {
		// Insert cursor into text at cursor position
		const before = state.customPrompt.slice(0, state.cursorPos);
		const after = state.customPrompt.slice(state.cursorPos);
		const textWithCursor = `${before}${cursor}${after}`;

		// Wrap text across multiple lines
		// Note: cursor adds ANSI codes but no visible width beyond the │ char
		const maxLines = 5;
		const text = state.customPrompt;
		for (let i = 0; i < maxLines && i * textW < text.length + 1; i++) {
			const sliceStart = i * textW;
			const sliceEnd = (i + 1) * textW;
			const linePrefix = i === 0 ? prefixStr : " ".repeat(prefixW);

			// Determine if cursor is in this line's range
			if (state.cursorPos >= sliceStart && state.cursorPos <= Math.min(sliceEnd, text.length) && sliceStart <= text.length) {
				const beforeInLine = text.slice(sliceStart, state.cursorPos);
				const afterInLine = text.slice(state.cursorPos, sliceEnd);
				lines.push(row(`${linePrefix}${beforeInLine}${cursor}${afterInLine}`));
			} else if (sliceStart < text.length) {
				const slice = text.slice(sliceStart, sliceEnd);
				lines.push(row(`${linePrefix}${slice}`));
			}
		}
	}

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
