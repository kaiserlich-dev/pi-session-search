import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	buildSearchNewContextCommand,
	parseSearchNewContextArgs,
	parseSearchResumePath,
	quoteCommandArg,
} from "../resume";

describe("parseSearchResumePath", () => {
	it("returns null when args are not resume subcommand", () => {
		assert.equal(parseSearchResumePath("stats"), null);
		assert.equal(parseSearchResumePath("resumee /tmp/foo"), null);
	});

	it("returns empty string when resume path is missing", () => {
		assert.equal(parseSearchResumePath("resume"), "");
		assert.equal(parseSearchResumePath("resume   "), "");
	});

	it("parses double-quoted path with spaces", () => {
		assert.equal(
			parseSearchResumePath('resume "/tmp/session with space.jsonl"'),
			"/tmp/session with space.jsonl",
		);
	});

	it("rejects unquoted or single-quoted paths", () => {
		assert.equal(
			parseSearchResumePath("resume /Users/julian/.pi/agent/sessions/a.jsonl"),
			"",
		);
		assert.equal(
			parseSearchResumePath("resume '/tmp/session with space.jsonl'"),
			"",
		);
	});
});

describe("parseSearchNewContextArgs", () => {
	// New + Context now routes through `/search new-context ...` so that the
	// actual session replacement happens from a command handler
	// (ExtensionCommandContext) instead of from the Ctrl+F shortcut path.
	//
	// These tests document the command grammar we rely on for that handoff.
	it("returns null when args are not new-context subcommand", () => {
		assert.equal(parseSearchNewContextArgs("stats"), null);
		assert.equal(parseSearchNewContextArgs("newcontext /tmp/foo"), null);
	});

	it("returns empty path when new-context path is missing", () => {
		assert.deepEqual(parseSearchNewContextArgs("new-context"), {
			sessionPath: "",
		});
	});

	it("parses quoted path and quoted focus prompt", () => {
		assert.deepEqual(
			parseSearchNewContextArgs(
				'new-context "/tmp/session with space.jsonl" "focus auth + tests"',
			),
			{
				sessionPath: "/tmp/session with space.jsonl",
				customPrompt: "focus auth + tests",
			},
		);
	});

	it("rejects unquoted trailing prompt", () => {
		assert.deepEqual(
			parseSearchNewContextArgs(
				"new-context /tmp/session.jsonl focus auth handoff",
			),
			{
				sessionPath: "",
			},
		);
	});

	it("rejects more than two quoted args", () => {
		assert.deepEqual(
			parseSearchNewContextArgs(
				'new-context "/tmp/session.jsonl" "focus" "extra"',
			),
			{ sessionPath: "" },
		);
	});
});

describe("quoteCommandArg", () => {
	it("quotes plain path", () => {
		assert.equal(quoteCommandArg("/tmp/session.jsonl"), '"/tmp/session.jsonl"');
	});

	it("escapes inner quotes and backslashes", () => {
		assert.equal(
			quoteCommandArg('/tmp/with "quotes" and \\ slash.jsonl'),
			'"/tmp/with \\\"quotes\\\" and \\\\ slash.jsonl"',
		);
	});
});

describe("buildSearchNewContextCommand", () => {
	// This is the inverse of parseSearchNewContextArgs(): when the overlay is
	// opened from Ctrl+F, we prefill the editor with a slash command and let the
	// command handler perform `ctx.newSession(...)`.
	//
	// These tests keep that generated command line stable, especially around
	// quoting paths/prompts with spaces or quotes.
	it("builds command with quoted path only", () => {
		assert.equal(
			buildSearchNewContextCommand("/tmp/session with space.jsonl"),
			'/search new-context "/tmp/session with space.jsonl"',
		);
	});

	it("builds command with quoted path and prompt", () => {
		assert.equal(
			buildSearchNewContextCommand(
				"/tmp/session.jsonl",
				'focus "auth" handoff',
			),
			'/search new-context "/tmp/session.jsonl" "focus \\\"auth\\\" handoff"',
		);
	});
});
