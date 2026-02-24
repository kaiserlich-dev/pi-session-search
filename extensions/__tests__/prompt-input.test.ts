import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { handlePromptInput } from "../screens/prompt-input";
import type { PromptScreenState } from "../types";

const KEYS = {
	escape: "\u001b",
	enter: "\r",
	backspace: "\u007f",
	delete: "\u001b[3~",
	left: "\u001b[D",
	right: "\u001b[C",
	home: "\u001b[H",
	end: "\u001b[F",
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
		cursorPos: 0,
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
		const state = makeState({ customPrompt: "focus on auth", cursorPos: 13 });
		const action = handlePromptInput(state, KEYS.enter);
		assert.deepEqual(action, {
			type: "confirm",
			customPrompt: "focus on auth",
		});
	});

	it("typing adds characters at cursor", () => {
		const state = makeState({ customPrompt: "hel", cursorPos: 3 });
		const action = handlePromptInput(state, "l");
		assert.equal(action, undefined);
		assert.equal(state.customPrompt, "hell");
		assert.equal(state.cursorPos, 4);
	});

	it("backspace removes character before cursor", () => {
		const state = makeState({ customPrompt: "hello", cursorPos: 5 });
		const action = handlePromptInput(state, KEYS.backspace);
		assert.equal(action, undefined);
		assert.equal(state.customPrompt, "hell");
		assert.equal(state.cursorPos, 4);
	});

	it("backspace on empty prompt does nothing", () => {
		const state = makeState({ customPrompt: "", cursorPos: 0 });
		const action = handlePromptInput(state, KEYS.backspace);
		assert.equal(action, undefined);
		assert.equal(state.customPrompt, "");
	});

	it("returns undefined for unrecognized input", () => {
		const state = makeState();
		const action = handlePromptInput(state, "\u001b[A"); // up arrow
		assert.equal(action, undefined);
	});

	// ── Cursor movement ──────────────────────────────────────────────

	it("left arrow moves cursor left", () => {
		const state = makeState({ customPrompt: "hello", cursorPos: 3 });
		handlePromptInput(state, KEYS.left);
		assert.equal(state.cursorPos, 2);
	});

	it("right arrow moves cursor right", () => {
		const state = makeState({ customPrompt: "hello", cursorPos: 3 });
		handlePromptInput(state, KEYS.right);
		assert.equal(state.cursorPos, 4);
	});

	it("typing inserts at cursor middle", () => {
		const state = makeState({ customPrompt: "helo", cursorPos: 3 });
		handlePromptInput(state, "l");
		assert.equal(state.customPrompt, "hello");
		assert.equal(state.cursorPos, 4);
	});

	it("backspace deletes before cursor in middle", () => {
		const state = makeState({ customPrompt: "hellp", cursorPos: 4 });
		handlePromptInput(state, KEYS.backspace);
		assert.equal(state.customPrompt, "help");
		assert.equal(state.cursorPos, 3);
	});

	it("delete removes char after cursor", () => {
		const state = makeState({ customPrompt: "hellp", cursorPos: 3 });
		handlePromptInput(state, KEYS.delete);
		assert.equal(state.customPrompt, "help");
		assert.equal(state.cursorPos, 3);
	});

	// ── Paste support ────────────────────────────────────────────────

	it("pasting multi-char text inserts at cursor", () => {
		const state = makeState({ customPrompt: "hd", cursorPos: 1 });
		handlePromptInput(state, "ello worl");
		assert.equal(state.customPrompt, "hello world");
		assert.equal(state.cursorPos, 10);
	});
});
