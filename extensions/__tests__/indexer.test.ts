import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import { sanitizeTokens, buildFtsQuery, projectFromDir } from "../indexer";

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
