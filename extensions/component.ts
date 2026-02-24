import type {
	Theme,
	PaletteAction,
	SearchScreenState,
	PreviewScreenState,
	PromptScreenState,
	SearchAction,
	PreviewAction as PreviewActionResult,
	PromptAction,
} from "./types";
import { handleSearchInput, renderSearch } from "./screens/search";
import { handlePreviewInput, renderPreview } from "./screens/preview";
import { handlePromptInput, renderPromptInput } from "./screens/prompt-input";
import { search as indexerSearch, getSessionSnippets, getStats, listRecent } from "./indexer";

const BOX_WIDTH = 82;

export class SessionSearchComponent {
	private screen: "search" | "preview" | "promptInput" = "search";
	private searchState: SearchScreenState;
	private previewState: PreviewScreenState | null = null;
	private promptState: PromptScreenState | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private done: (action: PaletteAction) => void,
		private tui: { requestRender(): void },
		private theme: Theme,
	) {
		let totalSessions = 0;
		try {
			totalSessions = getStats().totalSessions;
		} catch {
			/* index may not be ready */
		}
		this.searchState = { query: "", cursorPos: 0, results: [], selected: 0, totalSessions };

		// Load recent sessions immediately so user sees them on open
		this.loadRecent();
	}

	render(_width: number): string[] {
		switch (this.screen) {
			case "search":
				return renderSearch(this.searchState, BOX_WIDTH, this.theme);
			case "preview":
				return renderPreview(this.previewState!, BOX_WIDTH, this.theme);
			case "promptInput":
				return renderPromptInput(this.promptState!, BOX_WIDTH, this.theme);
		}
	}

	invalidate() {}

	handleInput(data: string): void {
		let terminal = false;

		switch (this.screen) {
			case "search":
				terminal = this.onSearchAction(
					handleSearchInput(this.searchState, data),
				);
				break;
			case "preview":
				terminal = this.onPreviewAction(
					handlePreviewInput(this.previewState!, data),
				);
				break;
			case "promptInput":
				terminal = this.onPromptAction(
					handlePromptInput(this.promptState!, data),
				);
				break;
		}

		if (!terminal) this.tui.requestRender();
	}

	// ── Action handlers ───────────────────────────────────────────────

	private onSearchAction(action: SearchAction | undefined): boolean {
		if (!action) return false;

		switch (action.type) {
			case "cancel":
				this.cleanup();
				this.done({ type: "cancel" });
				return true;

			case "select":
				this.enterPreview(action.index);
				return false;

			case "navigate": {
				const s = this.searchState;
				if (s.results.length > 0) {
					s.selected = Math.max(
						0,
						Math.min(s.results.length - 1, s.selected + action.direction),
					);
				}
				return false;
			}

			case "cursorMove":
				this.searchState.cursorPos = action.cursorPos;
				return false;

			case "queryChanged":
				this.searchState.query = action.query;
				this.searchState.cursorPos = action.cursorPos;
				this.debouncedSearch();
				return false;
		}
	}

	private onPreviewAction(action: PreviewActionResult | undefined): boolean {
		if (!action) return false;

		switch (action.type) {
			case "back":
				this.screen = "search";
				return false;

			case "resume":
				this.done({ type: "resume", session: this.previewState!.session });
				return true;

			case "promptInput":
				this.promptState = {
					session: this.previewState!.session,
					pendingActionType: action.actionType,
					customPrompt: "",
					cursorPos: 0,
				};
				this.screen = "promptInput";
				return false;
		}
	}

	private onPromptAction(action: PromptAction | undefined): boolean {
		if (!action) return false;

		switch (action.type) {
			case "back":
				this.screen = "preview";
				return false;

			case "confirm": {
				const session = this.promptState!.session;
				const actionType = this.promptState!.pendingActionType;
				if (actionType === "summarize") {
					this.done({
						type: "summarize",
						session,
						customPrompt: action.customPrompt,
					});
				} else {
					this.done({
						type: "newSession",
						session,
						customPrompt: action.customPrompt,
					});
				}
				return true;
			}
		}
	}

	// ── Internal helpers ──────────────────────────────────────────────

	private enterPreview(index: number): void {
		const session = this.searchState.results[index];
		if (!session) return;

		const query = this.searchState.query.trim();
		let snippets: string[];
		try {
			snippets = query
				? getSessionSnippets(session.sessionPath, query)
				: [session.title || "No preview available"];
		} catch {
			snippets = ["Failed to load snippets"];
		}

		this.previewState = { session, snippets, previewAction: 0 };
		this.screen = "preview";
	}

	private loadRecent(): void {
		try {
			this.searchState.results = listRecent(20);
			this.searchState.selected = 0;
		} catch {
			/* index may not be ready */
		}
	}

	private doSearch(): void {
		const q = this.searchState.query.trim();
		if (!q) {
			this.loadRecent();
			this.tui.requestRender();
			return;
		}

		try {
			const prevPath =
				this.searchState.results[this.searchState.selected]?.sessionPath;
			const newResults = indexerSearch(q);
			this.searchState.results = newResults;
			if (prevPath) {
				const idx = newResults.findIndex((r) => r.sessionPath === prevPath);
				this.searchState.selected = idx >= 0 ? idx : 0;
			} else {
				this.searchState.selected = 0;
			}
		} catch {
			this.searchState.results = [];
			this.searchState.selected = 0;
		}

		this.tui.requestRender();
	}

	private debouncedSearch(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => this.doSearch(), 200);
	}

	private cleanup(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
	}
}
