import { matchesKey, truncateToWidth } from "@mariozechner/pi-tui";
import type { Theme, PreviewScreenState, PreviewAction } from "../types";
import { PREVIEW_ACTIONS, ACTION_LABELS, formatDate, shortenProject, cleanSnippet } from "../types";
import { makeBox, hl, wrapText } from "../lib/render-helpers";

const BOX_WIDTH = 82;

/**
 * Handle preview screen input.
 * Returns a typed action for screen transitions.
 * Tab/arrow cycling mutates state directly and returns undefined.
 */
export function handlePreviewInput(
	state: PreviewScreenState,
	data: string,
): PreviewAction | undefined {
	if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
		return { type: "back" };
	}

	if (matchesKey(data, "tab") || matchesKey(data, "right")) {
		state.previewAction = (state.previewAction + 1) % PREVIEW_ACTIONS.length;
		return;
	}

	if (matchesKey(data, "left")) {
		state.previewAction =
			(state.previewAction - 1 + PREVIEW_ACTIONS.length) % PREVIEW_ACTIONS.length;
		return;
	}

	if (matchesKey(data, "return")) {
		const action = PREVIEW_ACTIONS[state.previewAction];
		if (action === "back") return { type: "back" };
		if (action === "resume") return { type: "resume" };
		return { type: "promptInput", actionType: action };
	}

	return;
}

/**
 * Render the preview screen.
 */
export function renderPreview(
	state: PreviewScreenState,
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

	lines.push(topBorder("Session"));
	lines.push(emptyRow());

	const projectStr = shortenProject(session.project, 40);
	const dateStr = formatDate(session.timestamp);
	lines.push(row(`  ${bold(accent("📂"))} ${bold(accent(projectStr))}  ${dim(dateStr)}`));

	if (session.title) {
		const titleClean = session.title.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
		lines.push(row(`  ${muted(truncateToWidth(titleClean, innerW - 6, "…"))}`));
	}

	lines.push(emptyRow());
	lines.push(divider());
	lines.push(emptyRow());

	if (state.snippets.length === 0) {
		lines.push(row(muted("  No matching snippets")));
	} else {
		for (let i = 0; i < Math.min(state.snippets.length, 6); i++) {
			const snippet = hl(cleanSnippet(state.snippets[i]), theme);
			const snippetLines = wrapText(snippet, innerW - 8, 3);
			lines.push(row(`  ${dim(`${i + 1}.`)} ${snippetLines[0] || ""}`));
			for (let j = 1; j < snippetLines.length; j++) {
				lines.push(row(`     ${snippetLines[j]}`));
			}
			if (i < Math.min(state.snippets.length, 6) - 1) lines.push(emptyRow());
		}
	}

	lines.push(emptyRow());
	lines.push(divider());

	const actions = PREVIEW_ACTIONS.map((a, i) => {
		const label = ACTION_LABELS[a];
		if (i === state.previewAction) return bold(accent(`[${label}]`));
		return dim(`[${label}]`);
	});

	lines.push(row(`  ${actions.join(" ")}  ${accent("tab")} ${dim("cycle")}`));
	lines.push(bottomBorder());

	return lines;
}
