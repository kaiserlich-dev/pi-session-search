import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSearchResumePath, quoteCommandArg } from "../resume";

describe("parseSearchResumePath", () => {
	it("returns null when args are not resume subcommand", () => {
		assert.equal(parseSearchResumePath("stats"), null);
		assert.equal(parseSearchResumePath("resumee /tmp/foo"), null);
	});

	it("returns empty string when resume path is missing", () => {
		assert.equal(parseSearchResumePath("resume"), "");
		assert.equal(parseSearchResumePath("resume   "), "");
	});

	it("parses unquoted path", () => {
		assert.equal(
			parseSearchResumePath("resume /Users/julian/.pi/agent/sessions/a.jsonl"),
			"/Users/julian/.pi/agent/sessions/a.jsonl",
		);
	});

	it("parses double-quoted path with spaces", () => {
		assert.equal(
			parseSearchResumePath('resume "/tmp/session with space.jsonl"'),
			"/tmp/session with space.jsonl",
		);
	});

	it("parses single-quoted path with spaces", () => {
		assert.equal(
			parseSearchResumePath("resume '/tmp/session with space.jsonl'"),
			"/tmp/session with space.jsonl",
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
