import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import {
	buildFtsQuery,
	projectFromDir,
	sanitizeTokens,
	sessionResultFromPath,
} from "../indexer";

describe("sanitizeTokens", () => {
	it('splits "node.js" into ["node", "js"]', () => {
		assert.deepEqual(sanitizeTokens("node.js"), ["node", "js"]);
	});

	it("returns [] for empty string", () => {
		assert.deepEqual(sanitizeTokens(""), []);
	});

	it('splits "hello world" into ["hello", "world"]', () => {
		assert.deepEqual(sanitizeTokens("hello world"), ["hello", "world"]);
	});

	it("splits \"can't\" into [\"can\", \"t\"]", () => {
		assert.deepEqual(sanitizeTokens("can't"), ["can", "t"]);
	});

	it('splits "R&D" into ["R", "D"]', () => {
		assert.deepEqual(sanitizeTokens("R&D"), ["R", "D"]);
	});
});

describe("buildFtsQuery", () => {
	it('builds query for ["node", "js"]', () => {
		assert.equal(buildFtsQuery(["node", "js"]), '"node" "js"*');
	});

	it('builds query for ["hello"]', () => {
		assert.equal(buildFtsQuery(["hello"]), '"hello"*');
	});

	it("returns empty for []", () => {
		assert.equal(buildFtsQuery([]), "");
	});
});

describe("projectFromDir", () => {
	it("returns 'unknown' for empty string", () => {
		assert.equal(projectFromDir(""), "unknown");
	});

	it("returns 'unknown' for bare dashes", () => {
		assert.equal(projectFromDir("----"), "unknown");
	});

	it("returns '~' for home directory encoding", () => {
		const homeEncoded = os.homedir().slice(1).replace(/\//g, "-");
		assert.equal(projectFromDir(`--${homeEncoded}--`), "~");
	});

	it("returns encoded string when no code marker found", () => {
		const result = projectFromDir("--some-random-path--");
		assert.equal(result, "some-random-path");
	});
});

describe("sessionResultFromPath", () => {
	it("derives project and timestamp from session path", () => {
		// This helper is intentionally pure string/path parsing.
		// The `/tmp/...` prefix here is just a synthetic path; the test does not
		// read or write any real files.
		//
		// We care about two things:
		// 1. projectFromDir() still decodes the parent session directory name
		// 2. the timestamp is reconstructed from the JSONL filename format
		const encodedHome = os.homedir().slice(1).replace(/\//g, "-");
		const result = sessionResultFromPath(
			`/tmp/sessions/--${encodedHome}-workbench--/2026-04-22T10-11-12-345Z_abc123.jsonl`,
		);

		assert.equal(result.project, "workbench");
		assert.equal(result.timestamp, "2026-04-22T10:11:12.345Z");
		assert.equal(result.sessionPath.includes("abc123.jsonl"), true);
	});
});
