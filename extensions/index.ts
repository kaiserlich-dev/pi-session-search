/**
 * pi-session-search — Full-text search across all pi sessions.
 *
 * SQLite FTS5 index built incrementally on session_start.
 * Ctrl+F or /search opens an overlay palette to search, preview, resume, or
 * summarize past sessions into a new session.
 */

import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
	updateIndex,
	rebuildIndex,
	getStats,
	closeDb,
	sessionResultFromPath,
	type SearchResult,
} from "./indexer";
import type { PaletteAction } from "./types";
import { formatDate, shortenProject } from "./types";
import { SessionSearchComponent } from "./component";
import { summarizeSession } from "./summarizer";
import {
	buildSearchNewContextCommand,
	parseSearchNewContextArgs,
	parseSearchResumePath,
	quoteCommandArg,
} from "./resume";

export default function sessionSearch(pi: ExtensionAPI): void {
	let indexReady = false;
	let indexing = false;

	// Keep indexing single-flight so startup, `/search`, and Ctrl+F do not kick
	// off overlapping scans of the same session directory.
	async function ensureIndex(ctx?: ExtensionContext) {
		if (indexing) return;
		indexing = true;

		try {
			await updateIndex((msg) => {
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

	function buildSummaryMessage(session: SearchResult, summary: string): string {
		return (
			`## Session Summary: ${session.project}\n` +
			`**Date:** ${formatDate(session.timestamp)} | **File:** ${session.sessionPath}\n\n` +
			summary
		);
	}

	function isMissingSummaryKeyError(error: unknown): boolean {
		const message = error instanceof Error ? error.message : String(error);
		return (
			message.includes("No API key found at") ||
			message.includes("/session-search-register-key")
		);
	}

	function buildSummaryUnavailableMessage(
		session: SearchResult,
		error: unknown,
	): string {
		const body = isMissingSummaryKeyError(error)
			? [
				"Warning: Gemini key not configured; no summary added.",
				"Run `/session-search-register-key` and paste your OpenRouter API key into the local prompt.",
				"Assistant: if the user asks about the missing summary, explain that setup step clearly.",
			].join(" ")
			: [
				"Warning: Gemini summary failed; no summary added.",
				"Assistant: if the user asks about the missing summary, tell them summary generation failed and they can retry.",
			].join(" ");
		return (
			`## Session Summary: ${session.project}\n` +
			`**Date:** ${formatDate(session.timestamp)} | **File:** ${session.sessionPath}\n\n` +
			body
		);
	}

	// New + Context is intentionally implemented as a real session replacement
	// from a command handler. The important detail is seeding the new session in
	// `setup`: pi rebuilds the chat from SessionManager state after replacement,
	// so this is the reliable place to inject context.
	async function startNewSessionWithContext(
		ctx: ExtensionCommandContext,
		session: SearchResult,
		customPrompt?: string,
	): Promise<void> {
		const project = shortenProject(session.project, 40);
		ctx.ui.setStatus(
			"session-search",
			`🔍 Summarizing ${project} via Gemini...`,
		);

		let content: string;
		let notification: { message: string; level: "info" | "warning" } = {
			message: `Context injected from ${project}`,
			level: "info",
		};

		try {
			const summary = await summarizeSession(session, customPrompt);
			content = buildSummaryMessage(session, summary);
		} catch (err) {
			content = buildSummaryUnavailableMessage(session, err);
			notification = {
				message: isMissingSummaryKeyError(err)
					? "Warning: Gemini key not configured; no summary added."
					: `Gemini summary failed; no summary was added for ${project}`,
				level: "warning",
			};
		} finally {
			ctx.ui.setStatus("session-search", undefined);
		}

		const result = await ctx.newSession({
			setup: async (sessionManager) => {
				sessionManager.appendCustomMessageEntry(
					"session-search-context",
					content,
					true,
				);
			},
			withSession: async (newCtx) => {
				newCtx.ui.notify(notification.message, notification.level);
			},
		});

		if (result.cancelled) {
			ctx.ui.notify("New session cancelled", "info");
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		setTimeout(() => ensureIndex(ctx), 100);
	});

	pi.on("session_shutdown", async () => {
		closeDb();
	});

	// ── Open search overlay ───────────────────────────────────────────

	async function openSearch(ctx: ExtensionContext) {
		// This overlay is shared by two entrypoints:
		// - Ctrl+F shortcut -> plain ExtensionContext
		// - /search command  -> ExtensionCommandContext at runtime
		// Only the command path can call `newSession()` / `switchSession()`.
		if (!indexReady && !indexing) {
			ctx.ui.setStatus("session-search", "🔍 Building index...");
			await ensureIndex(ctx);
		}

		const action = await ctx.ui.custom<PaletteAction>(
			(tui, theme, _kb, done) =>
				new SessionSearchComponent(done, tui, theme),
			{
				overlay: true,
				overlayOptions: {
					anchor: "center" as any,
					width: 84,
				},
			},
		);

		if (action.type === "cancel") return;

		if (action.type === "resume") {
			// If we came from `/search`, resume directly. If we came from Ctrl+F, we
			// fall back to prefilling a slash command and let the command handler do
			// the actual session replacement.
			const sessionPath = action.session.sessionPath;
			const project = shortenProject(action.session.project, 40);

			const commandCtx = ctx as ExtensionContext &
				Partial<ExtensionCommandContext>;
			if (typeof commandCtx.switchSession === "function") {
				try {
					// pi ≥0.69 invalidates the outer ctx after switchSession;
					// do post-switch work via the withSession callback using
					// the fresh ReplacedSessionContext.
					await commandCtx.switchSession(sessionPath, {
						withSession: async (newCtx) => {
							newCtx.ui.notify(`Resumed ${project}`, "info");
						},
					});
				} catch (err) {
					ctx.ui.notify(`Resume failed: ${err}`, "error");
				}
				return;
			}

			ctx.ui.setEditorText(`/search resume ${quoteCommandArg(sessionPath)}`);
			ctx.ui.notify(
				`${project} — press Enter to resume this session`,
				"info",
			);
			return;
		}

		if (action.type === "summarize") {
			// Inject Here keeps the user in the current session. Even on failure we
			// still inject a visible custom message so the user can see why no
			// summary was added and the next assistant turn can relay the setup step.
			const project = shortenProject(action.session.project, 40);
			ctx.ui.setStatus(
				"session-search",
				`🔍 Summarizing ${project} via Gemini...`,
			);
			ctx.ui.notify(
				`Summarizing ${project} via Gemini Flash...`,
				"info",
			);

			try {
				const summary = await summarizeSession(
					action.session,
					action.customPrompt,
				);

				pi.sendMessage(
					{
						customType: "session-search-context",
						content:
							`## Session Summary: ${action.session.project}\n` +
							`**Date:** ${formatDate(action.session.timestamp)} | **File:** ${action.session.sessionPath}\n\n` +
							summary,
						display: true,
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);

				ctx.ui.notify(`Summary injected from ${project}`, "info");
			} catch (err) {
				pi.sendMessage(
					{
						customType: "session-search-context",
						content: buildSummaryUnavailableMessage(action.session, err),
						display: true,
					},
					{ triggerTurn: false, deliverAs: "followUp" },
				);
				ctx.ui.notify(
					isMissingSummaryKeyError(err)
						? "Warning: Gemini key not configured; no summary added."
						: `Gemini summary failed; added failure note for ${project}`,
					"warning",
				);
			} finally {
				ctx.ui.setStatus("session-search", undefined);
			}
			return;
		}

		if (action.type === "newSession") {
			// Ctrl+F cannot create the new session itself, so we prefill a command
			// line and let `/search new-context ...` route into the command-only
			// session-replacement API.
			const project = shortenProject(action.session.project, 40);
			ctx.ui.setEditorText(
				buildSearchNewContextCommand(
					action.session.sessionPath,
					action.customPrompt,
				),
			);
			ctx.ui.notify(
				`${project} — press Enter to start new session with context`,
				"info",
			);
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
			// `/search` doubles as the interactive entrypoint and as the command
			// trampoline for actions initiated from Ctrl+F (resume/new-context).
			const trimmedArgs = args?.trim() ?? "";
			const newContextArgs = parseSearchNewContextArgs(trimmedArgs);
			const resumePath = parseSearchResumePath(trimmedArgs);

			if (newContextArgs !== null) {
				if (!newContextArgs.sessionPath) {
					ctx.ui.notify(
						"Usage: /search new-context \"<sessionPath>\" [\"focus prompt\"]",
						"warning",
					);
					return;
				}

				try {
					await startNewSessionWithContext(
						ctx,
						sessionResultFromPath(newContextArgs.sessionPath),
						newContextArgs.customPrompt,
					);
				} catch (err) {
					ctx.ui.notify(`New + Context failed: ${err}`, "error");
				}
				return;
			}

			if (resumePath !== null) {
				if (!resumePath) {
					ctx.ui.notify("Usage: /search resume \"<sessionPath>\"", "warning");
					return;
				}

				try {
					await ctx.switchSession(resumePath, {
						withSession: async (newCtx) => {
							newCtx.ui.notify(`Resumed: ${resumePath}`, "info");
						},
					});
				} catch (err) {
					ctx.ui.notify(`Resume failed: ${err}`, "error");
				}
				return;
			}

			if (trimmedArgs === "reindex") {
				ctx.ui.notify("Rebuilding index from scratch...", "info");
				indexReady = false;
				try {
					const count = await rebuildIndex((msg) =>
						ctx.ui.notify(msg, "info"),
					);
					indexReady = true;
					ctx.ui.notify(`Rebuilt index: ${count} sessions`, "info");
				} catch (err) {
					ctx.ui.notify(`Reindex failed: ${err}`, "error");
				}
				return;
			}

			if (trimmedArgs === "stats") {
				try {
					const stats = getStats();
					ctx.ui.notify(
						`Sessions: ${stats.totalSessions} | Chunks: ${stats.totalChunks} | Updated: ${stats.lastUpdated ?? "never"}`,
						"info",
					);
				} catch (err) {
					ctx.ui.notify(`Stats failed: ${err}`, "error");
				}
				return;
			}

			await openSearch(ctx as ExtensionContext);
		},
	});

	pi.registerMessageRenderer(
		"session-search-context",
		(message, options, theme) => {
			// This renderer handles both successful summaries and the "summary
			// unavailable" notices. The collapsed header is deliberately explicit so
			// users can spot missing-key/failure states without expanding the body.
			const rawContent =
				typeof message.content === "string"
					? message.content
					: Array.isArray(message.content)
						? (message.content as any[])
								.map((c: any) =>
									c.type === "text" ? c.text || "" : "",
								)
								.join("")
						: "";

			// Parse from "## Session Summary: project" or "**Project:** project" format
			const summaryMatch = rawContent.match(
				/Session Summary:\s*(.+)/,
			);
			const projectMatch = rawContent.match(
				/\*\*Project:\*\*\s*(.+)/,
			);
			const dateMatch = rawContent.match(
				/\*\*Date:\*\*\s*([^|*]+)/,
			);
			const project =
				summaryMatch?.[1]?.trim() ||
				projectMatch?.[1]?.trim() ||
				"session";
			const date = dateMatch?.[1]?.trim() || "";
			const missingKeyWarning = rawContent.includes(
				"Warning: Gemini key not configured; no summary added.",
			);
			const summaryFailedWarning = rawContent.includes(
				"Warning: Gemini summary failed; no summary added.",
			);

			if (options.expanded) {
				const lines: string[] = [];
				lines.push(
					theme.fg("accent", "🔍 ") +
						theme.fg(
							"customMessageLabel",
							theme.bold("Session context: "),
						) +
						theme.fg("accent", project) +
						(date ? theme.fg("muted", ` (${date})`) : ""),
				);

				const bodyStart = rawContent.indexOf("\n\n");
				if (bodyStart >= 0) {
					const body = rawContent.slice(bodyStart + 2).trim();
					if (body) {
						lines.push("");
						lines.push(theme.fg("muted", body));
					}
				}

				return new Text(lines.join("\n"), 0, 0);
			}

			const header = missingKeyWarning
				? theme.fg("warning", "⚠ Warning: Gemini key not configured; no summary added.")
				: summaryFailedWarning
					? theme.fg("warning", "⚠ Warning: Gemini summary failed; no summary added.")
					: theme.fg("accent", "🔍 ") +
						theme.fg(
							"customMessageLabel",
							theme.bold("Session context: "),
						) +
						theme.fg("accent", project) +
						(date ? theme.fg("muted", ` (${date})`) : "");

			return new Text(header, 0, 0);
		},
	);
}
