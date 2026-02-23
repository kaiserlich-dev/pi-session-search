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

	if (matchesKey(data, "backspace")) {
		if (state.query.length > 0) {
			return { type: "queryChanged", query: state.query.slice(0, -1) };
		}
		return;
	}

	if (data.length === 1 && data.charCodeAt(0) >= 32) {
		return { type: "queryChanged", query: state.query + data };
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
	const queryDisplay = state.query
		? `${state.query}${cursor}`
		: `${cursor}${muted("type to search sessions...")}`;
	lines.push(row(`  ${dim("◎")} ${queryDisplay}`));

	if (state.totalSessions > 0) {
		lines.push(row(dim(`    ${state.totalSessions} sessions indexed`)));
	}

	lines.push(emptyRow());
	lines.push(divider());

	if (!state.query.trim()) {
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

			const snippet = hl(cleanSnippet(r.snippet), theme);
			lines.push(row(`    ${truncateToWidth(snippet, innerW - 8, "…")}`));

			if (i < endIdx - 1) lines.push(emptyRow());
		}

		lines.push(emptyRow());

		if (state.results.length > maxVisible) {
			lines.push(row(dim(`  ${state.selected + 1}/${state.results.length} results`)));
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
