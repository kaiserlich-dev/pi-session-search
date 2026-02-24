import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleSearchInput } from "../screens/search";
import type { SearchScreenState } from "../types";

const KEYS = {
	escape: "\u001b",
	enter: "\r",
	up: "\u001b[A",
	down: "\u001b[B",
	left: "\u001b[D",
	right: "\u001b[C",
	backspace: "\u007f",
	delete: "\u001b[3~",
	home: "\u001b[H",
	end: "\u001b[F",
};

function makeState(overrides?: Partial<SearchScreenState>): SearchScreenState {
	return {
		query: "",
		cursorPos: 0,
		results: [],
		selected: 0,
		totalSessions: 0,
		...overrides,
	};
}

describe("handleSearchInput", () => {
	it("escape returns cancel action", () => {
		const action = handleSearchInput(makeState(), KEYS.escape);
		assert.deepEqual(action, { type: "cancel" });
	});

	it("enter returns select action when results exist", () => {
		const state = makeState({
			results: [
				{
					sessionPath: "/test",
					project: "test",
					timestamp: "",
					snippet: "",
					rank: 0,
					title: null,
				},
			],
			selected: 0,
		});
		const action = handleSearchInput(state, KEYS.enter);
		assert.deepEqual(action, { type: "select", index: 0 });
	});

	it("enter returns undefined when no results", () => {
		const action = handleSearchInput(makeState(), KEYS.enter);
		assert.equal(action, undefined);
	});

	it("up returns navigate action", () => {
		const action = handleSearchInput(makeState(), KEYS.up);
		assert.deepEqual(action, { type: "navigate", direction: -1 });
	});

	it("down returns navigate action", () => {
		const action = handleSearchInput(makeState(), KEYS.down);
		assert.deepEqual(action, { type: "navigate", direction: 1 });
	});

	it("typing a character returns queryChanged with cursor position", () => {
		const state = makeState({ query: "hel", cursorPos: 3 });
		const action = handleSearchInput(state, "l");
		assert.deepEqual(action, { type: "queryChanged", query: "hell", cursorPos: 4 });
	});

	it("backspace returns queryChanged with shorter query", () => {
		const state = makeState({ query: "hello", cursorPos: 5 });
		const action = handleSearchInput(state, KEYS.backspace);
		assert.deepEqual(action, { type: "queryChanged", query: "hell", cursorPos: 4 });
	});

	it("backspace on empty query returns undefined", () => {
		const action = handleSearchInput(makeState(), KEYS.backspace);
		assert.equal(action, undefined);
	});

	it("returns undefined for unrecognized input", () => {
		const action = handleSearchInput(makeState(), "\u001b[15~"); // F5
		assert.equal(action, undefined);
	});

	// ── Cursor movement ──────────────────────────────────────────────

	it("left arrow moves cursor left", () => {
		const state = makeState({ query: "hello", cursorPos: 3 });
		const action = handleSearchInput(state, KEYS.left);
		assert.deepEqual(action, { type: "cursorMove", cursorPos: 2 });
	});

	it("left arrow at start returns undefined", () => {
		const state = makeState({ query: "hello", cursorPos: 0 });
		const action = handleSearchInput(state, KEYS.left);
		assert.equal(action, undefined);
	});

	it("right arrow moves cursor right", () => {
		const state = makeState({ query: "hello", cursorPos: 3 });
		const action = handleSearchInput(state, KEYS.right);
		assert.deepEqual(action, { type: "cursorMove", cursorPos: 4 });
	});

	it("right arrow at end returns undefined", () => {
		const state = makeState({ query: "hello", cursorPos: 5 });
		const action = handleSearchInput(state, KEYS.right);
		assert.equal(action, undefined);
	});

	// ── Cursor-aware editing ─────────────────────────────────────────

	it("typing inserts at cursor position (middle)", () => {
		const state = makeState({ query: "helo", cursorPos: 3 });
		const action = handleSearchInput(state, "l");
		assert.deepEqual(action, { type: "queryChanged", query: "hello", cursorPos: 4 });
	});

	it("backspace deletes before cursor (middle)", () => {
		const state = makeState({ query: "hellp", cursorPos: 4 });
		const action = handleSearchInput(state, KEYS.backspace);
		assert.deepEqual(action, { type: "queryChanged", query: "help", cursorPos: 3 });
	});

	it("delete removes char after cursor", () => {
		const state = makeState({ query: "hellp", cursorPos: 3 });
		const action = handleSearchInput(state, KEYS.delete);
		assert.deepEqual(action, { type: "queryChanged", query: "help", cursorPos: 3 });
	});

	it("delete at end returns undefined", () => {
		const state = makeState({ query: "hello", cursorPos: 5 });
		const action = handleSearchInput(state, KEYS.delete);
		assert.equal(action, undefined);
	});

	// ── Paste support ────────────────────────────────────────────────

	it("pasting multi-char text inserts at cursor", () => {
		const state = makeState({ query: "hd", cursorPos: 1 });
		const action = handleSearchInput(state, "ello worl");
		assert.deepEqual(action, { type: "queryChanged", query: "hello world", cursorPos: 10 });
	});

	it("pasting at end appends", () => {
		const state = makeState({ query: "hello", cursorPos: 5 });
		const action = handleSearchInput(state, " world");
		assert.deepEqual(action, { type: "queryChanged", query: "hello world", cursorPos: 11 });
	});

	it("pasting into empty query works", () => {
		const state = makeState({ query: "", cursorPos: 0 });
		const action = handleSearchInput(state, "pasted text");
		assert.deepEqual(action, { type: "queryChanged", query: "pasted text", cursorPos: 11 });
	});
});
