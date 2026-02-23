/**
 * pi-session-search — Full-text search across all pi sessions.
 *
 * SQLite FTS5 index built incrementally on session_start.
 * Ctrl+F or /search opens an overlay palette to search, preview, resume, or
 * summarize past sessions into a new session.
 *
 * Search view:
 *   - Type to search (debounced, prefix-matched)
 *   - ↑/↓ navigate results
 *   - Enter → preview & actions
 *   - Escape → close
 *
 * Preview/actions view:
 *   - Tab / ←→ to cycle action: Resume / Inject Here / New + Context / Back
 *   - Enter to execute selected action
 *   - Escape → back to search
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth, Text } from "@mariozechner/pi-tui";
import {
	updateIndex,
	search,
	getSessionSnippets,
	getStats,
	closeDb,
	type SearchResult,
} from "./indexer.js";

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

function formatDate(ts: string): string {
	if (!ts) return "unknown";
	try {
		const d = new Date(ts);
		const now = new Date();
		const diffMs = now.getTime() - d.getTime();
		const diffDays = Math.floor(diffMs / 86400000);

		const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
		if (diffDays === 0) return `Today ${time}`;
		if (diffDays === 1) return `Yesterday ${time}`;
		if (diffDays < 7) return `${diffDays}d ago ${time}`;

		return d.toLocaleDateString("en-GB", { month: "short", day: "numeric" }) + ` ${time}`;
	} catch {
		return ts.slice(0, 10);
	}
}

function shortenProject(project: string, maxLen: number): string {
	if (project.length <= maxLen) return project;
	const parts = project.split("/");
	if (parts.length >= 2) {
		const short = parts.slice(-2).join("/");
		if (short.length <= maxLen) return short;
		return parts[parts.length - 1].slice(0, maxLen);
	}
	return project.slice(0, maxLen);
}

function cleanSnippet(snippet: string): string {
	return snippet.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

// ANSI helpers
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

// ═══════════════════════════════════════════════════════════════════════════
// Box drawing
// ═══════════════════════════════════════════════════════════════════════════

function makeBox(innerW: number) {
	function row(content = ""): string {
		const clipped = truncateToWidth(content, innerW - 1, "");
		const vis = visibleWidth(clipped);
		const pad = Math.max(0, innerW - vis - 1);
		return dim("│") + " " + clipped + " ".repeat(pad) + dim("│");
	}

	function emptyRow(): string {
		return dim("│") + " ".repeat(innerW) + dim("│");
	}

	function divider(): string {
		return dim(`├${"─".repeat(innerW)}┤`);
	}

	function topBorder(title: string): string {
		const titleText = ` ${title} `;
		const borderLen = Math.max(0, innerW - titleText.length);
		const left = Math.floor(borderLen / 2);
		const right = borderLen - left;
		return dim(`╭${"─".repeat(left)}`) + dim(titleText) + dim(`${"─".repeat(right)}╮`);
	}

	function bottomBorder(): string {
		return dim(`╰${"─".repeat(innerW)}╯`);
	}

	return { row, emptyRow, divider, topBorder, bottomBorder };
}

// ═══════════════════════════════════════════════════════════════════════════
// Search Overlay Component
// ═══════════════════════════════════════════════════════════════════════════

type PaletteAction =
	| { type: "cancel" }
	| { type: "resume"; session: SearchResult }
	| { type: "summarize"; session: SearchResult }
	| { type: "newSession"; session: SearchResult };

type PreviewAction = "resume" | "summarize" | "newSession" | "back";
const PREVIEW_ACTIONS: PreviewAction[] = ["resume", "summarize", "newSession", "back"];

const ACTION_LABELS: Record<PreviewAction, string> = {
	resume: "⏎ Resume",
	summarize: "📋 Inject Here",
	newSession: "✦ New + Context",
	back: "← Back",
};

interface SearchState {
	query: string;
	results: SearchResult[];
	selected: number;
	mode: "search" | "preview";
	previewSnippets: string[];
	previewSession: SearchResult | null;
	previewAction: number;
	debounceTimer: ReturnType<typeof setTimeout> | null;
}

function createSearchComponent(
	done: (action: PaletteAction) => void,
	tui: any,
) {
	const BOX_WIDTH = 82;
	const innerW = BOX_WIDTH - 2;
	const { row, emptyRow, divider, topBorder, bottomBorder } = makeBox(innerW);

	const state: SearchState = {
		query: "",
		results: [],
		selected: 0,
		mode: "search",
		previewSnippets: [],
		previewSession: null,
		previewAction: 0,
		debounceTimer: null,
	};

	function doSearch() {
		const q = state.query.trim();
		if (!q) {
			state.results = [];
			state.selected = 0;
			tui.requestRender();
			return;
		}

		try {
			const newResults = search(q);
			const prevPath = state.results[state.selected]?.sessionPath;
			state.results = newResults;
			if (prevPath) {
				const idx = newResults.findIndex((r) => r.sessionPath === prevPath);
				state.selected = idx >= 0 ? idx : 0;
			} else {
				state.selected = 0;
			}
		} catch {
			state.results = [];
			state.selected = 0;
		}

		tui.requestRender();
	}

	function debouncedSearch() {
		if (state.debounceTimer) clearTimeout(state.debounceTimer);
		state.debounceTimer = setTimeout(() => doSearch(), 200);
	}

	function enterPreview() {
		if (state.results.length === 0) return;
		const session = state.results[state.selected];
		try {
			state.previewSnippets = getSessionSnippets(session.sessionPath, state.query);
		} catch {
			state.previewSnippets = ["Failed to load snippets"];
		}
		state.previewSession = session;
		state.previewAction = 0;
		state.mode = "preview";
		tui.requestRender();
	}

	function hl(text: string): string {
		return text.replace(/→([^←]*)←/g, (_m, p1) => bold(yellow(p1)));
	}

	function wrapText(text: string, maxW: number, maxLines = 3): string[] {
		if (visibleWidth(text) <= maxW) return [text];
		const result: string[] = [];
		let remaining = text;
		for (let i = 0; i < maxLines && remaining.length > 0; i++) {
			result.push(truncateToWidth(remaining, maxW, i < maxLines - 1 ? "" : "…"));
			remaining = remaining.slice(maxW);
		}
		return result;
	}

	// ── Render search ─────────────────────────────────────────────────

	function renderSearch(): string[] {
		const lines: string[] = [];

		lines.push(topBorder("Session Search"));
		lines.push(emptyRow());

		const cursor = cyan("│");
		const queryDisplay = state.query
			? `${state.query}${cursor}`
			: `${cursor}${dim(italic("type to search sessions..."))}`;
		lines.push(row(`  ${dim("◎")} ${queryDisplay}`));

		try {
			const stats = getStats();
			lines.push(row(dim(`    ${stats.totalSessions} sessions indexed`)));
		} catch { /* */ }

		lines.push(emptyRow());
		lines.push(divider());

		if (!state.query.trim()) {
			lines.push(emptyRow());
			lines.push(row(dim(italic("  Start typing to search across all sessions"))));
			lines.push(emptyRow());
		} else if (state.results.length === 0) {
			lines.push(emptyRow());
			lines.push(row(dim(italic("  No results"))));
			lines.push(emptyRow());
		} else {
			const maxVisible = 10;
			const startIdx = Math.max(
				0,
				Math.min(state.selected - Math.floor(maxVisible / 2), state.results.length - maxVisible)
			);
			const endIdx = Math.min(startIdx + maxVisible, state.results.length);

			lines.push(emptyRow());

			for (let i = startIdx; i < endIdx; i++) {
				const r = state.results[i];
				const isSel = i === state.selected;
				const prefix = isSel ? cyan("▸") : dim("·");

				const dateStr = formatDate(r.timestamp);
				const projectStr = shortenProject(r.project, 24);

				lines.push(row(`  ${prefix} ${isSel ? bold(cyan(projectStr)) : projectStr}  ${dim(dateStr)}`));

				if (r.title) {
					const titleMaxW = innerW - 8;
					const titleClean = r.title.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
					lines.push(row(`    ${dim(italic(truncateToWidth(titleClean, titleMaxW, "…")))}`));
				}

				const snippet = hl(cleanSnippet(r.snippet));
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
			row(`${dim(italic("↑↓"))} ${dim("nav")}  ${dim(italic("enter"))} ${dim("select")}  ${dim(italic("esc"))} ${dim("close")}`)
		);
		lines.push(bottomBorder());

		return lines;
	}

	// ── Render preview ────────────────────────────────────────────────

	function renderPreview(): string[] {
		const lines: string[] = [];
		const session = state.previewSession!;

		lines.push(topBorder("Session"));
		lines.push(emptyRow());

		const projectStr = shortenProject(session.project, 40);
		const dateStr = formatDate(session.timestamp);
		lines.push(row(`  ${bold(cyan("📂"))} ${bold(cyan(projectStr))}  ${dim(dateStr)}`));

		if (session.title) {
			const titleClean = session.title.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
			lines.push(row(`  ${dim(italic(truncateToWidth(titleClean, innerW - 6, "…")))}`));
		}

		lines.push(emptyRow());
		lines.push(divider());
		lines.push(emptyRow());

		if (state.previewSnippets.length === 0) {
			lines.push(row(dim(italic("  No matching snippets"))));
		} else {
			for (let i = 0; i < Math.min(state.previewSnippets.length, 6); i++) {
				const snippet = hl(cleanSnippet(state.previewSnippets[i]));
				const snippetLines = wrapText(snippet, innerW - 8, 3);
				lines.push(row(`  ${dim(`${i + 1}.`)} ${snippetLines[0] || ""}`));
				for (let j = 1; j < snippetLines.length; j++) {
					lines.push(row(`     ${snippetLines[j]}`));
				}
				if (i < Math.min(state.previewSnippets.length, 6) - 1) lines.push(emptyRow());
			}
		}

		lines.push(emptyRow());
		lines.push(divider());

		const actions = PREVIEW_ACTIONS.map((a, i) => {
			const label = ACTION_LABELS[a];
			if (i === state.previewAction) return bold(cyan(`[${label}]`));
			return dim(`[${label}]`);
		});

		lines.push(row(`  ${actions.join(" ")}  ${dim(italic("tab"))} ${dim("cycle")}`));
		lines.push(bottomBorder());

		return lines;
	}

	// ── Input handling ────────────────────────────────────────────────

	function handleSearchInput(data: string) {
		if (matchesKey(data, "escape")) {
			if (state.debounceTimer) clearTimeout(state.debounceTimer);
			done({ type: "cancel" });
			return;
		}

		if (matchesKey(data, "return")) {
			enterPreview();
			return;
		}

		if (matchesKey(data, "up")) {
			if (state.results.length > 0) {
				state.selected = Math.max(0, state.selected - 1);
				tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "down")) {
			if (state.results.length > 0) {
				state.selected = Math.min(state.results.length - 1, state.selected + 1);
				tui.requestRender();
			}
			return;
		}

		if (matchesKey(data, "backspace")) {
			if (state.query.length > 0) {
				state.query = state.query.slice(0, -1);
				debouncedSearch();
				tui.requestRender();
			}
			return;
		}

		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			state.query += data;
			debouncedSearch();
			tui.requestRender();
		}
	}

	function handlePreviewInput(data: string) {
		if (matchesKey(data, "escape") || matchesKey(data, "backspace")) {
			state.mode = "search";
			tui.requestRender();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			state.previewAction = (state.previewAction + 1) % PREVIEW_ACTIONS.length;
			tui.requestRender();
			return;
		}

		if (matchesKey(data, "left")) {
			state.previewAction = (state.previewAction - 1 + PREVIEW_ACTIONS.length) % PREVIEW_ACTIONS.length;
			tui.requestRender();
			return;
		}

		if (matchesKey(data, "return")) {
			const action = PREVIEW_ACTIONS[state.previewAction];
			if (action === "back") {
				state.mode = "search";
				tui.requestRender();
				return;
			}
			const session = state.previewSession!;
			if (action === "resume") done({ type: "resume", session });
			else if (action === "summarize") done({ type: "summarize", session });
			else if (action === "newSession") done({ type: "newSession", session });
		}
	}

	return {
		render(_width: number): string[] {
			return state.mode === "preview" ? renderPreview() : renderSearch();
		},
		invalidate() {},
		handleInput(data: string) {
			if (state.mode === "preview") handlePreviewInput(data);
			else handleSearchInput(data);
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Summarize prompt
// ═══════════════════════════════════════════════════════════════════════════

function buildSummarizePrompt(session: SearchResult): string {
	const project = session.project;
	const date = formatDate(session.timestamp);
	return (
		`I found a relevant past session. Here are the details:\n` +
		`- **Project:** ${project}\n` +
		`- **Date:** ${date}\n` +
		`- **Session file:** ${session.sessionPath}\n\n` +
		`Please read this session file and provide a concise summary of what was discussed and accomplished. ` +
		`Focus on the key decisions, outcomes, and any important context that might be relevant now.`
	);
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Entry
// ═══════════════════════════════════════════════════════════════════════════

export default function sessionSearch(pi: ExtensionAPI): void {
	let indexReady = false;
	let indexing = false;

	// Pending context injection — set when user picks "New + Context",
	// consumed when the new session starts via session_switch.
	let pendingContext: SearchResult | null = null;

	async function ensureIndex(ctx?: ExtensionContext) {
		if (indexing) return;
		indexing = true;

		try {
			updateIndex((msg) => {
				ctx?.ui?.setStatus("session-search", `🔍 ${msg}`);
			});
			indexReady = true;
		} catch {
			// will retry on next search
		} finally {
			ctx?.ui?.setStatus("session-search", undefined);
			indexing = false;
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		setTimeout(() => ensureIndex(ctx), 100);
	});

	pi.on("session_shutdown", async () => {
		closeDb();
	});

	// When a new session starts and we have pending context, inject it.
	pi.on("session_switch", async (event, _ctx) => {
		if (event.reason !== "new" || !pendingContext) return;

		const session = pendingContext;
		pendingContext = null;

		// Inject summarize prompt into the fresh session and trigger the LLM
		pi.sendMessage(
			{
				customType: "session-search-context",
				content: buildSummarizePrompt(session),
				display: true,
			},
			{ triggerTurn: true }
		);
	});

	// ── Open search overlay ───────────────────────────────────────────

	async function openSearch(ctx: ExtensionContext) {
		if (!indexReady && !indexing) {
			ctx.ui.setStatus("session-search", "🔍 Building index...");
			await ensureIndex(ctx);
		}

		const action = await ctx.ui.custom<PaletteAction>(
			(tui, _theme, _kb, done) => createSearchComponent(done, tui),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center" as any,
					width: 84,
				},
			}
		);

		if (action.type === "cancel") return;

		if (action.type === "resume") {
			const sessionPath = action.session.sessionPath;
			const project = shortenProject(action.session.project, 40);

			try {
				const { execSync } = await import("node:child_process");
				execSync("pbcopy", { input: sessionPath });
			} catch { /* non-fatal */ }

			ctx.ui.setEditorText(`/resume`);
			ctx.ui.notify(`${project} — path copied, press Enter for /resume`, "info");
			return;
		}

		if (action.type === "summarize") {
			ctx.ui.notify(`Summarizing: ${shortenProject(action.session.project, 40)}...`, "info");

			pi.sendMessage(
				{
					customType: "session-search-context",
					content: buildSummarizePrompt(action.session),
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" }
			);
			return;
		}

		if (action.type === "newSession") {
			const project = shortenProject(action.session.project, 40);

			// Stash the session — will be injected when /new creates the fresh session
			pendingContext = action.session;

			// Pre-fill /new and tell the user to press Enter
			ctx.ui.setEditorText(`/new`);
			ctx.ui.notify(`${project} — press Enter to start new session with context`, "info");
			return;
		}
	}

	pi.registerShortcut("ctrl+f", {
		description: "Search sessions",
		handler: (ctx) => openSearch(ctx as ExtensionContext),
	});

	pi.registerCommand("search", {
		description: "Full-text search across all pi sessions",
		handler: async (args, ctx) => {
			if (args?.trim() === "reindex") {
				ctx.ui.notify("Reindexing all sessions...", "info");
				indexReady = false;
				try {
					const count = updateIndex((msg) => ctx.ui.notify(msg, "info"));
					indexReady = true;
					ctx.ui.notify(`Reindexed ${count} sessions`, "info");
				} catch (err) {
					ctx.ui.notify(`Reindex failed: ${err}`, "error");
				}
				return;
			}

			if (args?.trim() === "stats") {
				try {
					const stats = getStats();
					ctx.ui.notify(
						`Sessions: ${stats.totalSessions} | Chunks: ${stats.totalChunks} | Updated: ${stats.lastUpdated ?? "never"}`,
						"info"
					);
				} catch (err) {
					ctx.ui.notify(`Stats failed: ${err}`, "error");
				}
				return;
			}

			await openSearch(ctx as ExtensionContext);
		},
	});

	pi.registerMessageRenderer("session-search-context", (message, _options, theme) => {
		const rawContent =
			typeof message.content === "string"
				? message.content
				: Array.isArray(message.content)
					? (message.content as any[])
							.map((c: any) => (c.type === "text" ? c.text || "" : ""))
							.join("")
					: "";

		const projectMatch = rawContent.match(/\*\*Project:\*\* (.+)/);
		const dateMatch = rawContent.match(/\*\*Date:\*\* (.+)/);
		const project = projectMatch?.[1] || "session";
		const date = dateMatch?.[1] || "";

		const header =
			theme.fg("accent", "🔍 ") +
			theme.fg("customMessageLabel", theme.bold("Session context: ")) +
			theme.fg("accent", project) +
			(date ? theme.fg("muted", ` (${date})`) : "");

		return new Text(header, 0, 0);
	});
}
