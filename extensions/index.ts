/**
 * pi-session-search — Full-text search across all pi sessions.
 *
 * SQLite FTS5 index built incrementally on session_start.
 * Ctrl+F or /search opens an overlay palette to search, preview, resume, or
 * summarize past sessions.
 *
 * In the search view:
 *   - Type to search (debounced)
 *   - ↑/↓ to navigate results
 *   - Enter to preview snippets
 *   - Ctrl+R to resume selected session
 *   - Ctrl+S to summarize & inject
 *   - Escape to close
 *
 * In the preview view:
 *   - Ctrl+R to resume
 *   - Ctrl+S to summarize & inject
 *   - Escape / Backspace to go back
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

/** Clean FTS snippet markers for display. */
function cleanSnippet(snippet: string): string {
	return snippet.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}

// ═══════════════════════════════════════════════════════════════════════════
// ANSI helpers (same pattern as queue-picker / skill-palette)
// ═══════════════════════════════════════════════════════════════════════════

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;

// ═══════════════════════════════════════════════════════════════════════════
// Box drawing — shared between search and preview
// ═══════════════════════════════════════════════════════════════════════════

function makeBoxHelpers(innerW: number) {
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
	| { type: "preview"; session: SearchResult; query: string };

interface SearchState {
	query: string;
	results: SearchResult[];
	selected: number;
	mode: "search" | "preview";
	previewSnippets: string[];
	previewSession: SearchResult | null;
	debounceTimer: ReturnType<typeof setTimeout> | null;
}

function createSearchComponent(
	done: (action: PaletteAction) => void,
	tui: any,
) {
	const BOX_WIDTH = 82;
	const innerW = BOX_WIDTH - 2;
	const { row, emptyRow, divider, topBorder, bottomBorder } = makeBoxHelpers(innerW);

	const state: SearchState = {
		query: "",
		results: [],
		selected: 0,
		mode: "search",
		previewSnippets: [],
		previewSession: null,
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
			// Preserve selection if the previously selected session is still in results
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
		state.mode = "preview";
		tui.requestRender();
	}

	function selectedSession(): SearchResult | null {
		if (state.mode === "preview") return state.previewSession;
		if (state.results.length === 0) return null;
		return state.results[state.selected];
	}

	/** Replace →text← FTS markers with bold yellow highlights. */
	function highlightMatches(text: string): string {
		return text.replace(/→([^←]*)←/g, (_match, p1) => bold(yellow(p1)));
	}

	function wrapText(text: string, maxW: number): string[] {
		if (visibleWidth(text) <= maxW) return [text];
		const result: string[] = [];
		let remaining = text;
		for (let i = 0; i < 4 && remaining.length > 0; i++) {
			result.push(truncateToWidth(remaining, maxW, i < 3 ? "" : "…"));
			remaining = remaining.slice(maxW);
		}
		return result;
	}

	// ── Render ────────────────────────────────────────────────────────

	function renderSearch(): string[] {
		const lines: string[] = [];

		lines.push(topBorder("Session Search"));
		lines.push(emptyRow());

		// Search input
		const cursor = cyan("│");
		const queryDisplay = state.query
			? `${state.query}${cursor}`
			: `${cursor}${dim(italic("type to search sessions..."))}`;
		lines.push(row(`  ${dim("◎")} ${queryDisplay}`));

		// Stats line
		try {
			const stats = getStats();
			lines.push(row(dim(`    ${stats.totalSessions} sessions indexed`)));
		} catch {
			// ignore
		}

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
				const result = state.results[i];
				const isSel = i === state.selected;
				const prefix = isSel ? cyan("▸") : dim("·");

				const dateStr = formatDate(result.timestamp);
				const projectStr = shortenProject(result.project, 28);

				const header = `${prefix} ${isSel ? bold(cyan(projectStr)) : projectStr}  ${dim(dateStr)}`;
				lines.push(row(`  ${header}`));

				// Snippet with highlights
				const snippet = highlightMatches(cleanSnippet(result.snippet));
				const snippetMaxW = innerW - 8;
				lines.push(row(`    ${truncateToWidth(snippet, snippetMaxW, "…")}`));

				if (i < endIdx - 1) lines.push(emptyRow());
			}

			lines.push(emptyRow());

			if (state.results.length > maxVisible) {
				lines.push(row(dim(`  ${state.selected + 1}/${state.results.length} results`)));
			}
		}

		lines.push(divider());

		const help =
			`${dim(italic("↑↓"))} ${dim("nav")}  ` +
			`${dim(italic("enter"))} ${dim("preview")}  ` +
			`${dim(italic("^R"))} ${dim("resume")}  ` +
			`${dim(italic("^S"))} ${dim("summarize")}  ` +
			`${dim(italic("esc"))} ${dim("close")}`;
		lines.push(row(help));
		lines.push(bottomBorder());

		return lines;
	}

	function renderPreview(): string[] {
		const lines: string[] = [];
		const session = state.previewSession!;

		lines.push(topBorder("Preview"));
		lines.push(emptyRow());

		const projectStr = shortenProject(session.project, 40);
		const dateStr = formatDate(session.timestamp);
		lines.push(row(`  ${bold(cyan("📂"))} ${bold(cyan(projectStr))}  ${dim(dateStr)}`));
		lines.push(emptyRow());
		lines.push(divider());
		lines.push(emptyRow());

		if (state.previewSnippets.length === 0) {
			lines.push(row(dim(italic("  No snippets found"))));
		} else {
			for (let i = 0; i < Math.min(state.previewSnippets.length, 8); i++) {
				const snippet = highlightMatches(cleanSnippet(state.previewSnippets[i]));
				const snippetLines = wrapText(snippet, innerW - 8);
				lines.push(row(`  ${dim(`${i + 1}.`)} ${snippetLines[0] || ""}`));
				for (let j = 1; j < snippetLines.length; j++) {
					lines.push(row(`     ${snippetLines[j]}`));
				}
				if (i < state.previewSnippets.length - 1) lines.push(emptyRow());
			}
		}

		lines.push(emptyRow());
		lines.push(divider());

		const help =
			`${dim(italic("^R"))} ${dim("resume")}  ` +
			`${dim(italic("^S"))} ${dim("summarize")}  ` +
			`${dim(italic("esc"))} ${dim("back")}`;
		lines.push(row(help));
		lines.push(bottomBorder());

		return lines;
	}

	// ── Input ─────────────────────────────────────────────────────────

	function handleSearchInput(data: string) {
		if (matchesKey(data, "escape")) {
			if (state.debounceTimer) clearTimeout(state.debounceTimer);
			done({ type: "cancel" });
			return;
		}

		// Ctrl+R — resume (won't conflict with typing)
		if (matchesKey(data, "ctrl+r")) {
			const s = selectedSession();
			if (s) {
				if (state.debounceTimer) clearTimeout(state.debounceTimer);
				done({ type: "resume", session: s });
			}
			return;
		}

		// Ctrl+S — summarize
		if (matchesKey(data, "ctrl+s")) {
			const s = selectedSession();
			if (s) {
				if (state.debounceTimer) clearTimeout(state.debounceTimer);
				done({ type: "summarize", session: s });
			}
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

		// Printable characters → always go to search input
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

		if (matchesKey(data, "ctrl+r")) {
			done({ type: "resume", session: state.previewSession! });
			return;
		}

		if (matchesKey(data, "ctrl+s")) {
			done({ type: "summarize", session: state.previewSession! });
			return;
		}
	}

	// ── Component interface ───────────────────────────────────────────

	return {
		render(_width: number): string[] {
			return state.mode === "preview" ? renderPreview() : renderSearch();
		},
		invalidate() {},
		handleInput(data: string) {
			if (state.mode === "preview") {
				handlePreviewInput(data);
			} else {
				handleSearchInput(data);
			}
		},
	};
}

// ═══════════════════════════════════════════════════════════════════════════
// Extension Entry
// ═══════════════════════════════════════════════════════════════════════════

export default function sessionSearch(pi: ExtensionAPI): void {
	let indexReady = false;
	let indexing = false;

	/** Run index update in background. */
	async function ensureIndex(ctx?: ExtensionContext) {
		if (indexing) return;
		indexing = true;

		try {
			const count = updateIndex((msg) => {
				ctx?.ui?.setStatus("session-search", `🔍 ${msg}`);
			});
			indexReady = true;
		} catch {
			// index failed — will retry on next search
		} finally {
			ctx?.ui?.setStatus("session-search", undefined);
			indexing = false;
		}
	}

	// Index on startup (background, next tick)
	pi.on("session_start", async (_event, ctx) => {
		setTimeout(() => ensureIndex(ctx), 100);
	});

	pi.on("session_shutdown", async () => {
		closeDb();
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

			// Copy path to clipboard
			try {
				const { execSync } = await import("node:child_process");
				execSync("pbcopy", { input: sessionPath });
			} catch {
				// non-fatal
			}

			// Pre-fill /resume in editor
			ctx.ui.setEditorText(`/resume`);
			ctx.ui.notify(`${project} — path copied, press Enter for /resume`, "info");
			return;
		}

		if (action.type === "summarize") {
			const sessionPath = action.session.sessionPath;
			const project = action.session.project;
			const date = formatDate(action.session.timestamp);

			ctx.ui.notify(`Summarizing: ${shortenProject(project, 40)}...`, "info");

			pi.sendMessage(
				{
					customType: "session-search-context",
					content:
						`I found a relevant past session. Here are the details:\n` +
						`- **Project:** ${project}\n` +
						`- **Date:** ${date}\n` +
						`- **Session file:** ${sessionPath}\n\n` +
						`Please read this session file and provide a concise summary of what was discussed and accomplished. ` +
						`Focus on the key decisions, outcomes, and any important context that might be relevant now.`,
					display: true,
				},
				{ triggerTurn: true, deliverAs: "followUp" }
			);
			return;
		}
	}

	// Ctrl+F shortcut
	pi.registerShortcut("ctrl+f", {
		description: "Search sessions",
		handler: (ctx) => openSearch(ctx as ExtensionContext),
	});

	// /search command
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

	// Custom renderer for session-search-context messages
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
