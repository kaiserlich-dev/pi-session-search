import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handlePromptInput } from "../screens/prompt-input";
import type { PromptScreenState } from "../types";

const KEYS = {
	escape: "\u001b",
	enter: "\r",
	backspace: "\u007f",
};

const mockSession = {
	sessionPath: "/test",
	project: "test/project",
	timestamp: "2026-01-01T00:00:00Z",
	snippet: "",
	rank: 0,
	title: null,
};

function makeState(overrides?: Partial<PromptScreenState>): PromptScreenState {
	return {
		session: mockSession,
		pendingActionType: "summarize",
		customPrompt: "",
		...overrides,
	};
}

describe("handlePromptInput", () => {
	it("escape returns back action", () => {
		const action = handlePromptInput(makeState(), KEYS.escape);
		assert.deepEqual(action, { type: "back" });
	});

	it("enter with empty text returns confirm with no customPrompt", () => {
		const action = handlePromptInput(makeState(), KEYS.enter);
		assert.deepEqual(action, { type: "confirm", customPrompt: undefined });
	});

	it("enter with text returns confirm with customPrompt", () => {
		const state = makeState({ customPrompt: "focus on auth" });
		const action = handlePromptInput(state, KEYS.enter);
		assert.deepEqual(action, {
			type: "confirm",
			customPrompt: "focus on auth",
		});
	});

	it("typing adds characters", () => {
		const state = makeState({ customPrompt: "hel" });
		const action = handlePromptInput(state, "l");
		assert.equal(action, undefined);
		assert.equal(state.customPrompt, "hell");
	});

	it("backspace removes last character", () => {
		const state = makeState({ customPrompt: "hello" });
		const action = handlePromptInput(state, KEYS.backspace);
		assert.equal(action, undefined);
		assert.equal(state.customPrompt, "hell");
	});

	it("backspace on empty prompt does nothing", () => {
		const state = makeState({ customPrompt: "" });
		const action = handlePromptInput(state, KEYS.backspace);
		assert.equal(action, undefined);
		assert.equal(state.customPrompt, "");
	});

	it("returns undefined for unrecognized input", () => {
		const state = makeState();
		const action = handlePromptInput(state, "\u001b[A"); // up arrow
		assert.equal(action, undefined);
	});
});
