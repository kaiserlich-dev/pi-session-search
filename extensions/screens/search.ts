import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme, SearchScreenState, SearchAction } from "../types";
import { formatDate, shortenProject, cleanSnippet } from "../types";
import { makeBox, hl } from "../lib/render-helpers";

const BOX_WIDTH = 82;

/**
 * Handle search screen input.
 * Returns a typed action or undefined (for unrecognized keys).
 * Never mutates state — the component handles all state updates.
 */
export function handleSearchInput(
	state: SearchScreenState,
	data: string,
): SearchAction | undefined {
	if (matchesKey(data, "escape")) {
		return { type: "cancel" };
	}

	if (matchesKey(data, "return")) {
		if (state.results.length > 0) {
			return { type: "select", index: state.selected };
		}
		return;
	}

	if (matchesKey(data, "up")) {
		return { type: "navigate", direction: -1 };
	}

	if (matchesKey(data, "down")) {
		return { type: "navigate", direction: 1 };
	}

	// Cursor movement
	if (matchesKey(data, "left")) {
		if (state.cursorPos > 0) {
			return { type: "cursorMove", cursorPos: state.cursorPos - 1 };
		}
		return;
	}

	if (matchesKey(data, "right")) {
		if (state.cursorPos < state.query.length) {
			return { type: "cursorMove", cursorPos: state.cursorPos + 1 };
		}
		return;
	}

	if (matchesKey(data, "home") || matchesKey(data, "ctrl+a")) {
		return { type: "cursorMove", cursorPos: 0 };
	}

	if (matchesKey(data, "end") || matchesKey(data, "ctrl+e")) {
		return { type: "cursorMove", cursorPos: state.query.length };
	}

	// Alt+Backspace / Ctrl+W: delete word before cursor
	if (matchesKey(data, "ctrl+w") || matchesKey(data, "alt+backspace")) {
		if (state.cursorPos === 0) return;
		const before = state.query.slice(0, state.cursorPos);
		const after = state.query.slice(state.cursorPos);
		// Find word boundary: skip trailing spaces, then skip non-spaces
		let i = before.length;
		while (i > 0 && before[i - 1] === " ") i--;
		while (i > 0 && before[i - 1] !== " ") i--;
		const newQuery = before.slice(0, i) + after;
		return { type: "queryChanged", query: newQuery, cursorPos: i };
	}

	// Backspace: delete char before cursor
	if (matchesKey(data, "backspace")) {
		if (state.cursorPos > 0) {
			const newQuery =
				state.query.slice(0, state.cursorPos - 1) +
				state.query.slice(state.cursorPos);
			return { type: "queryChanged", query: newQuery, cursorPos: state.cursorPos - 1 };
		}
		return;
	}

	// Delete: delete char after cursor
	if (matchesKey(data, "delete")) {
		if (state.cursorPos < state.query.length) {
			const newQuery =
				state.query.slice(0, state.cursorPos) +
				state.query.slice(state.cursorPos + 1);
			return { type: "queryChanged", query: newQuery, cursorPos: state.cursorPos };
		}
		return;
	}

	// Paste or single character: insert at cursor position
	// Multi-char data = paste; single printable char = typing
	if (data.length >= 1 && data.charCodeAt(0) >= 32 && !data.startsWith("\x1b")) {
		const newQuery =
			state.query.slice(0, state.cursorPos) +
			data +
			state.query.slice(state.cursorPos);
		return { type: "queryChanged", query: newQuery, cursorPos: state.cursorPos + data.length };
	}

	return;
}

/**
 * Render the search screen.
 */
export function renderSearch(
	state: SearchScreenState,
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

	lines.push(topBorder("Session Search"));
	lines.push(emptyRow());

	const cursor = accent("│");
	let queryDisplay: string;
	if (!state.query) {
		queryDisplay = `${cursor}${muted("type to search sessions...")}`;
	} else {
		const before = state.query.slice(0, state.cursorPos);
		const after = state.query.slice(state.cursorPos);
		queryDisplay = `${before}${cursor}${after}`;
	}
	lines.push(row(`  ${dim("◎")} ${queryDisplay}`));

	if (state.totalSessions > 0) {
		lines.push(row(dim(`    ${state.totalSessions} sessions indexed`)));
	}

	lines.push(emptyRow());
	lines.push(divider());

	if (!state.query.trim() && state.results.length === 0) {
		lines.push(emptyRow());
		lines.push(row(muted("  Start typing to search across all sessions")));
		lines.push(emptyRow());
	} else if (state.results.length === 0) {
		lines.push(emptyRow());
		lines.push(row(muted("  No results")));
		lines.push(emptyRow());
	} else {
		const maxVisible = 10;
		const startIdx = Math.max(
			0,
			Math.min(state.selected - Math.floor(maxVisible / 2), state.results.length - maxVisible),
		);
		const endIdx = Math.min(startIdx + maxVisible, state.results.length);

		lines.push(emptyRow());

		for (let i = startIdx; i < endIdx; i++) {
			const r = state.results[i];
			const isSel = i === state.selected;
			const prefix = isSel ? accent("▸") : dim("·");

			const dateStr = formatDate(r.timestamp);
			const projectStr = shortenProject(r.project, 24);

			lines.push(
				row(`  ${prefix} ${isSel ? bold(accent(projectStr)) : projectStr}  ${dim(dateStr)}`),
			);

			if (r.title) {
				const titleMaxW = innerW - 8;
				const titleClean = r.title.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
				lines.push(row(`    ${muted(truncateToWidth(titleClean, titleMaxW, "…"))}`));
			}

			const snippet = state.query.trim()
				? hl(cleanSnippet(r.snippet), theme)
				: muted(cleanSnippet(r.title || ""));
			if (snippet) {
				lines.push(row(`    ${truncateToWidth(snippet, innerW - 8, "…")}`));
			}

			if (i < endIdx - 1) lines.push(emptyRow());
		}

		lines.push(emptyRow());

		const label = state.query.trim() ? "results" : "recent";
		if (state.results.length > maxVisible) {
			lines.push(row(dim(`  ${state.selected + 1}/${state.results.length} ${label}`)));
		}
	}

	lines.push(divider());
	lines.push(
		row(
			`${accent("↑↓")} ${dim("nav")}  ${accent("enter")} ${dim("select")}  ${accent("esc")} ${dim("close")}`,
		),
	);
	lines.push(bottomBorder());

	return lines;
}
