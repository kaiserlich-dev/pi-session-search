import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handlePreviewInput } from "../screens/preview";
import type { PreviewScreenState } from "../types";

const KEYS = {
	escape: "\u001b",
	enter: "\r",
	tab: "\t",
	backspace: "\u007f",
	right: "\u001b[C",
	left: "\u001b[D",
};

const mockSession = {
	sessionPath: "/test",
	project: "test/project",
	timestamp: "2026-01-01T00:00:00Z",
	snippet: "",
	rank: 0,
	title: null,
};

function makeState(overrides?: Partial<PreviewScreenState>): PreviewScreenState {
	return {
		session: mockSession,
		snippets: [],
		previewAction: 0,
		...overrides,
	};
}

describe("handlePreviewInput", () => {
	it("escape returns back action", () => {
		const action = handlePreviewInput(makeState(), KEYS.escape);
		assert.deepEqual(action, { type: "back" });
	});

	it("backspace returns back action", () => {
		const action = handlePreviewInput(makeState(), KEYS.backspace);
		assert.deepEqual(action, { type: "back" });
	});

	it("tab cycles previewAction forward", () => {
		const state = makeState({ previewAction: 0 });
		const action = handlePreviewInput(state, KEYS.tab);
		assert.equal(action, undefined);
		assert.equal(state.previewAction, 1);
	});

	it("tab wraps around from last to first", () => {
		const state = makeState({ previewAction: 3 });
		handlePreviewInput(state, KEYS.tab);
		assert.equal(state.previewAction, 0);
	});

	it("left cycles previewAction backward", () => {
		const state = makeState({ previewAction: 1 });
		handlePreviewInput(state, KEYS.left);
		assert.equal(state.previewAction, 0);
	});

	it("left wraps around from first to last", () => {
		const state = makeState({ previewAction: 0 });
		handlePreviewInput(state, KEYS.left);
		assert.equal(state.previewAction, 3);
	});

	it("enter on 'resume' (index 0) returns resume action", () => {
		const state = makeState({ previewAction: 0 });
		const action = handlePreviewInput(state, KEYS.enter);
		assert.deepEqual(action, { type: "resume" });
	});

	it("enter on 'summarize' (index 1) returns promptInput action", () => {
		const state = makeState({ previewAction: 1 });
		const action = handlePreviewInput(state, KEYS.enter);
		assert.deepEqual(action, {
			type: "promptInput",
			actionType: "summarize",
		});
	});

	it("enter on 'newSession' (index 2) returns promptInput action", () => {
		const state = makeState({ previewAction: 2 });
		const action = handlePreviewInput(state, KEYS.enter);
		assert.deepEqual(action, {
			type: "promptInput",
			actionType: "newSession",
		});
	});

	it("enter on 'back' (index 3) returns back action", () => {
		const state = makeState({ previewAction: 3 });
		const action = handlePreviewInput(state, KEYS.enter);
		assert.deepEqual(action, { type: "back" });
	});

	it("returns undefined for unrecognized input", () => {
		const state = makeState();
		const action = handlePreviewInput(state, "x");
		assert.equal(action, undefined);
	});
});
