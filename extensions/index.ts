/**
 * pi-session-search — Full-text search across all pi sessions.
 *
 * SQLite FTS5 index built incrementally on session_start.
 * Ctrl+F or /search opens an overlay palette to search, preview, resume, or
 * summarize past sessions.
 *
 * Actions on a selected session:
 *   - Enter: preview matched snippets
 *   - R: resume (switch to that session)
 *   - S: summarize & inject context into current session
 *   - Escape: close
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
	// Try to keep the last meaningful parts
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
	searching: boolean;
	debounceTimer: ReturnType<typeof setTimeout> | null;
}

function createSearchComponent(
	done: (action: PaletteAction) => void,
	tui: any,
) {
	const BOX_WIDTH = 82;
	const innerW = BOX_WIDTH - 2;

	const state: SearchState = {
		query: "",
		results: [],
		selected: 0,
		mode: "search",
		previewSnippets: [],
		previewSession: null,
		searching: false,
		debounceTimer: null,
	};

	// Styling helpers (raw ANSI — same pattern as queue-picker / skill-palette)
	const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
	const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
	const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
	const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
	const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;
	const italic = (s: string) => `\x1b[3m${s}\x1b[23m`;
	const magenta = (s: string) => `\x1b[35m${s}\x1b[39m`;

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

	function doSearch() {
		if (!state.query.trim()) {
			state.results = [];
			state.selected = 0;
			tui.requestRender();
			return;
		}

		state.searching = true;
		tui.requestRender();

		try {
			state.results = search(state.query.trim());
		} catch {
			state.results = [];
		}

		state.selected = 0;
		state.searching = false;
		tui.requestRender();
	}

	function debouncedSearch() {
		if (state.debounceTimer) clearTimeout(state.debounceTimer);
		state.debounceTimer = setTimeout(() => doSearch(), 150);
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

	function highlightMatches(text: string): string {
		// Replace → and ← markers from FTS snippet() with styling
		return text.replace(/→([^←]*)←/g, (_match, p1) => bold(yellow(p1)));
	}

	return {
		render(_width: number): string[] {
			const lines: string[] = [];

			if (state.mode === "preview") {
				return renderPreview(lines);
			}

			return renderSearch(lines);
		},

		invalidate() {},

		handleInput(data: string) {
			if (state.mode === "preview") {
				handlePreviewInput(data);
				return;
			}

			handleSearchInput(data);
		},
	};

	function renderSearch(lines: string[]): string[] {
		lines.push(topBorder("Session Search"));
		lines.push(emptyRow());

		// Search input
		const cursor = cyan("│");
		const queryDisplay = state.query
			? `${state.query}${cursor}`
			: `${cursor}${dim(italic("type to search sessions..."))}`;
		lines.push(row(`${dim("◎")}  ${queryDisplay}`));

		// Stats
		try {
			const stats = getStats();
			lines.push(row(dim(`  ${stats.totalSessions} sessions indexed`)));
		} catch {
			// ignore
		}

		lines.push(emptyRow());
		lines.push(divider());

		if (state.searching) {
			lines.push(emptyRow());
			lines.push(row(dim(italic("  Searching..."))));
			lines.push(emptyRow());
		} else if (!state.query.trim()) {
			lines.push(emptyRow());
			lines.push(row(dim(italic("  Start typing to search across all sessions"))));
			lines.push(emptyRow());
		} else if (state.results.length === 0) {
			lines.push(emptyRow());
			lines.push(row(dim(italic("  No results"))));
			lines.push(emptyRow());
		} else {
			const maxVisible = 12;
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
				lines.push(
					row(dim(`${state.selected + 1}/${state.results.length} results`))
				);
			}
		}

		lines.push(divider());

		const help =
			`${dim(italic("↑↓"))} ${dim("nav")}  ` +
			`${dim(italic("enter"))} ${dim("preview")}  ` +
			`${dim(italic("r"))} ${dim("resume")}  ` +
			`${dim(italic("s"))} ${dim("summarize")}  ` +
			`${dim(italic("esc"))} ${dim("close")}`;
		lines.push(row(help));
		lines.push(bottomBorder());

		return lines;
	}

	function renderPreview(lines: string[]): string[] {
		const session = state.previewSession!;

		lines.push(topBorder("Preview"));
		lines.push(emptyRow());

		const projectStr = shortenProject(session.project, 40);
		const dateStr = formatDate(session.timestamp);
		lines.push(row(`${bold(cyan("📂"))} ${bold(cyan(projectStr))}  ${dim(dateStr)}`));
		lines.push(emptyRow());
		lines.push(divider());
		lines.push(emptyRow());

		if (state.previewSnippets.length === 0) {
			lines.push(row(dim(italic("  No snippets found"))));
		} else {
			for (let i = 0; i < state.previewSnippets.length; i++) {
				const snippet = highlightMatches(cleanSnippet(state.previewSnippets[i]));
				const snippetLines = wrapText(snippet, innerW - 6);
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
			`${dim(italic("r"))} ${dim("resume")}  ` +
			`${dim(italic("s"))} ${dim("summarize")}  ` +
			`${dim(italic("esc/backspace"))} ${dim("back")}`;
		lines.push(row(help));
		lines.push(bottomBorder());

		return lines;
	}

	function wrapText(text: string, maxW: number): string[] {
		if (visibleWidth(text) <= maxW) return [text];
		// Simple wrap by truncation — for overlay display
		const result: string[] = [];
		let remaining = text;
		for (let i = 0; i < 4 && remaining.length > 0; i++) {
			result.push(truncateToWidth(remaining, maxW, i < 3 ? "" : "…"));
			// Rough estimate: advance by maxW visible chars
			remaining = remaining.slice(maxW);
		}
		return result;
	}

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

		// Action shortcuts on selected result
		if (state.results.length > 0) {
			if (data === "r" || data === "R") {
				if (state.debounceTimer) clearTimeout(state.debounceTimer);
				done({ type: "resume", session: state.results[state.selected] });
				return;
			}
			if (data === "s" || data === "S") {
				if (state.debounceTimer) clearTimeout(state.debounceTimer);
				done({ type: "summarize", session: state.results[state.selected] });
				return;
			}
		}

		if (matchesKey(data, "backspace")) {
			if (state.query.length > 0) {
				state.query = state.query.slice(0, -1);
				debouncedSearch();
				tui.requestRender();
			}
			return;
		}

		// Printable character
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

		if (data === "r" || data === "R") {
			done({ type: "resume", session: state.previewSession! });
			return;
		}

		if (data === "s" || data === "S") {
			done({ type: "summarize", session: state.previewSession! });
			return;
		}
	}
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

			if (count > 0) {
				ctx?.ui?.setStatus("session-search", undefined);
			} else {
				ctx?.ui?.setStatus("session-search", undefined);
			}
		} catch (err) {
			ctx?.ui?.setStatus("session-search", undefined);
		} finally {
			indexing = false;
		}
	}

	// Index on startup (background)
	pi.on("session_start", async (_event, ctx) => {
		// Run in next tick so it doesn't block session start
		setTimeout(() => ensureIndex(ctx), 100);
	});

	pi.on("session_shutdown", async () => {
		closeDb();
	});

	// --- Open search overlay ---

	async function openSearch(ctx: ExtensionContext, isCommand = false) {
		// Ensure index is ready
		if (!indexReady && !indexing) {
			ctx.ui.setStatus("session-search", "🔍 Building index...");
			await ensureIndex(ctx);
			ctx.ui.setStatus("session-search", undefined);
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

			// Copy path to clipboard so user can paste into /resume
			try {
				const { execSync } = await import("node:child_process");
				execSync("pbcopy", { input: sessionPath });
			} catch {
				// Clipboard unavailable — non-fatal
			}

			// Inject the path as editor text so /resume can use it
			ctx.ui.setEditorText(`/resume`);
			ctx.ui.notify(`${project} — path copied, press Enter for /resume`, "info");
			return;
		}

		if (action.type === "summarize") {
			ctx.ui.notify(`Summarizing session from ${shortenProject(action.session.project, 40)}...`, "info");
			// Inject a user message asking the LLM to read and summarize the session
			const sessionPath = action.session.sessionPath;
			const project = action.session.project;
			const date = formatDate(action.session.timestamp);

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

		if (action.type === "preview") {
			// Preview already shown in overlay — if they backed out, we're done
			return;
		}
	}

	// Ctrl+F shortcut
	pi.registerShortcut("ctrl+f", {
		description: "Search sessions",
		handler: (ctx) => openSearch(ctx as ExtensionContext, false),
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
						`Sessions: ${stats.totalSessions} | Chunks: ${stats.totalChunks} | Last updated: ${stats.lastUpdated ?? "never"}`,
						"info"
					);
				} catch (err) {
					ctx.ui.notify(`Stats failed: ${err}`, "error");
				}
				return;
			}

			await openSearch(ctx as ExtensionContext, true);
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

		// Extract project and date from the content
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
