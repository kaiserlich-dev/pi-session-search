import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handleSearchInput } from "../screens/search";
import type { SearchScreenState } from "../types";

const KEYS = {
	escape: "\u001b",
	enter: "\r",
	up: "\u001b[A",
	down: "\u001b[B",
	backspace: "\u007f",
};

function makeState(overrides?: Partial<SearchScreenState>): SearchScreenState {
	return {
		query: "",
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

	it("typing a character returns queryChanged", () => {
		const state = makeState({ query: "hel" });
		const action = handleSearchInput(state, "l");
		assert.deepEqual(action, { type: "queryChanged", query: "hell" });
	});

	it("backspace returns queryChanged with shorter query", () => {
		const state = makeState({ query: "hello" });
		const action = handleSearchInput(state, KEYS.backspace);
		assert.deepEqual(action, { type: "queryChanged", query: "hell" });
	});

	it("backspace on empty query returns undefined", () => {
		const action = handleSearchInput(makeState(), KEYS.backspace);
		assert.equal(action, undefined);
	});

	it("returns undefined for unrecognized input", () => {
		const action = handleSearchInput(makeState(), "\u001b[15~"); // F5
		assert.equal(action, undefined);
	});
});
