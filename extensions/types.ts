import type { SearchResult } from "./indexer";
export type { SearchResult };

export type Theme = Parameters<
	Parameters<import("@mariozechner/pi-coding-agent").ExtensionContext["ui"]["custom"]>[0]
>[1];

// ── Final palette action (returned to index.ts) ──────────────────────

export type PaletteAction =
	| { type: "cancel" }
	| { type: "resume"; session: SearchResult }
	| { type: "summarize"; session: SearchResult; customPrompt?: string }
	| { type: "newSession"; session: SearchResult; customPrompt?: string };

// ── Preview action types ─────────────────────────────────────────────

export type PreviewActionType = "resume" | "summarize" | "newSession" | "back";

export const PREVIEW_ACTIONS: PreviewActionType[] = [
	"resume",
	"summarize",
	"newSession",
	"back",
];

export const ACTION_LABELS: Record<PreviewActionType, string> = {
	resume: "⏎ Resume",
	summarize: "📋 Inject Here",
	newSession: "✦ New + Context",
	back: "← Back",
};

// ── Screen action unions ─────────────────────────────────────────────

export type SearchAction =
	| { type: "cancel" }
	| { type: "select"; index: number }
	| { type: "navigate"; direction: 1 | -1 }
	| { type: "queryChanged"; query: string; cursorPos: number }
	| { type: "cursorMove"; cursorPos: number };

export type PreviewAction =
	| { type: "back" }
	| { type: "resume" }
	| { type: "promptInput"; actionType: "summarize" | "newSession" };

export type PromptAction =
	| { type: "back" }
	| { type: "confirm"; customPrompt?: string };

// ── Screen states ────────────────────────────────────────────────────

export interface SearchScreenState {
	query: string;
	cursorPos: number;
	results: SearchResult[];
	selected: number;
	totalSessions: number;
}

export interface PreviewScreenState {
	session: SearchResult;
	snippets: string[];
	previewAction: number;
}

export interface PromptScreenState {
	session: SearchResult;
	pendingActionType: "summarize" | "newSession";
	customPrompt: string;
	cursorPos: number;
}

// ── Utility functions ────────────────────────────────────────────────

export function formatDate(ts: string): string {
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

export function shortenProject(project: string, maxLen: number): string {
	if (project.length <= maxLen) return project;
	const parts = project.split("/");
	if (parts.length >= 2) {
		const short = parts.slice(-2).join("/");
		if (short.length <= maxLen) return short;
		return parts[parts.length - 1].slice(0, maxLen);
	}
	return project.slice(0, maxLen);
}

export function cleanSnippet(snippet: string): string {
	return snippet.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
}
