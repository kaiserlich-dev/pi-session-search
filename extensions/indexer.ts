/**
 * Session indexer — SQLite FTS5 index for pi session JSONL files.
 *
 * Extracts user messages, assistant text (no thinking), and session metadata.
 * Incremental: only re-indexes files whose mtime changed since last indexed.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const INDEX_DIR = path.join(os.homedir(), ".pi-session-search");
const DB_PATH = path.join(INDEX_DIR, "index.db");

export interface SearchResult {
	sessionPath: string;
	project: string;
	timestamp: string;
	snippet: string;
	rank: number;
	title: string | null;
}

export interface IndexStats {
	totalSessions: number;
	totalChunks: number;
	lastUpdated: string | null;
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
	if (_db) return _db;

	if (!fs.existsSync(INDEX_DIR)) {
		fs.mkdirSync(INDEX_DIR, { recursive: true });
	}

	_db = new Database(DB_PATH);
	_db.pragma("journal_mode = WAL");
	_db.pragma("synchronous = NORMAL");

	_db.exec(`
		CREATE TABLE IF NOT EXISTS sessions (
			path TEXT PRIMARY KEY,
			project TEXT NOT NULL,
			session_ts TEXT NOT NULL,
			mtime_ms INTEGER NOT NULL,
			first_user_message TEXT
		);

		CREATE VIRTUAL TABLE IF NOT EXISTS session_fts USING fts5(
			content,
			session_path UNINDEXED,
			tokenize='porter unicode61'
		);

		CREATE TABLE IF NOT EXISTS meta (
			key TEXT PRIMARY KEY,
			value TEXT
		);
	`);

	return _db;
}

export function closeDb(): void {
	if (_db) {
		_db.close();
		_db = null;
	}
}

/**
 * Cache for ~/code/ directory listings: owner → Set<repo>.
 * Populated once per indexing run for greedy path resolution.
 */
let _codeDirs: Map<string, Set<string>> | null = null;

function getCodeDirs(): Map<string, Set<string>> {
	if (_codeDirs) return _codeDirs;
	_codeDirs = new Map();

	const codeDir = path.join(os.homedir(), "code");
	if (!fs.existsSync(codeDir)) return _codeDirs;

	try {
		for (const owner of fs.readdirSync(codeDir)) {
			const ownerPath = path.join(codeDir, owner);
			try {
				if (!fs.statSync(ownerPath).isDirectory()) continue;
			} catch { continue; }

			const repos = new Set<string>();
			try {
				for (const repo of fs.readdirSync(ownerPath)) {
					try {
						if (fs.statSync(path.join(ownerPath, repo)).isDirectory()) {
							repos.add(repo);
						}
					} catch { /* skip */ }
				}
			} catch { /* skip */ }
			_codeDirs.set(owner, repos);
		}
	} catch { /* code dir inaccessible */ }

	return _codeDirs;
}

/** Reset the code dirs cache (call between indexing runs if needed). */
function resetCodeDirsCache(): void {
	_codeDirs = null;
}

/**
 * Derive a human-readable project name from the session directory path.
 *
 * Directory names encode the original path by replacing `/` with `-` and
 * wrapping in `--`, e.g. `/Users/julian/code/kaiserlich-dev/festung`
 * → `--Users-julian-code-kaiserlich-dev-festung--`.
 *
 * Since path components can also contain hyphens, we resolve ambiguity
 * by checking actual directories under ~/code/ (greedy longest-match).
 */
export function projectFromDir(dirName: string): string {
	// Strip leading/trailing --
	const encoded = dirName.replace(/^--/, "").replace(/--$/, "");
	if (!encoded) return "unknown";

	// Find the "code-" marker
	const codeMarker = "code-";
	const codeIdx = encoded.indexOf(codeMarker);

	if (codeIdx < 0) {
		// No code dir — try stripping home prefix
		const homeEncoded = os.homedir().slice(1).replace(/\//g, "-"); // strip leading /
		if (encoded === homeEncoded) return "~";
		if (encoded.startsWith(homeEncoded + "-")) {
			return encoded.slice(homeEncoded.length + 1) || "~";
		}
		return encoded;
	}

	const remaining = encoded.slice(codeIdx + codeMarker.length);
	if (!remaining) return "~/code";

	// Greedily resolve against actual filesystem directories
	const codeDirs = getCodeDirs();
	const segments = remaining.split("-");

	// Try to find the owner (may contain hyphens) — longest match wins
	let owner = "";
	let ownerEndIdx = 0;

	for (let i = 1; i <= segments.length; i++) {
		const candidate = segments.slice(0, i).join("-");
		if (codeDirs.has(candidate)) {
			owner = candidate;
			ownerEndIdx = i;
		}
	}

	if (!owner) {
		// Fallback: can't resolve, use first segment as owner
		if (segments.length === 1) return segments[0];
		return segments[0] + "/" + segments.slice(1).join("-");
	}

	if (ownerEndIdx >= segments.length) return owner;

	// Try to find the repo (may contain hyphens) — longest match wins
	const repoSegments = segments.slice(ownerEndIdx);
	const repos = codeDirs.get(owner);

	if (repos && repos.size > 0) {
		let repo = "";
		let repoEndIdx = 0;

		for (let i = 1; i <= repoSegments.length; i++) {
			const candidate = repoSegments.slice(0, i).join("-");
			if (repos.has(candidate)) {
				repo = candidate;
				repoEndIdx = i;
			}
		}

		if (repo) {
			const rest = repoSegments.slice(repoEndIdx);
			if (rest.length > 0) {
				return `${owner}/${repo}/${rest.join("-")}`;
			}
			return `${owner}/${repo}`;
		}
	}

	// Fallback: owner resolved, rest is opaque
	return `${owner}/${repoSegments.join("-")}`;
}

/** Extract session timestamp from filename like 2026-02-18T16-02-59-202Z_uuid.jsonl */
function timestampFromFilename(filename: string): string {
	const match = filename.match(/^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})/);
	if (!match) return "";
	// Convert back: 2026-02-18T16-02-59 → 2026-02-18T16:02:59
	return filename
		.replace(/\.jsonl$/, "")
		.replace(/_[a-f0-9-]+$/, "")
		.replace(/T(\d{2})-(\d{2})-(\d{2})-(\d+)Z/, "T$1:$2:$3.$4Z");
}

/** Extract indexable text from a JSONL session file. */
function extractContent(filePath: string): { chunks: string[]; firstUserMessage: string | null } {
	const chunks: string[] = [];
	let firstUserMessage: string | null = null;

	let data: string;
	try {
		data = fs.readFileSync(filePath, "utf-8");
	} catch {
		return { chunks, firstUserMessage };
	}

	const lines = data.split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;

		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type !== "message") continue;

		const msg = entry.message;
		if (!msg) continue;

		const role = msg.role;

		if (role === "user") {
			const text = extractText(msg.content);
			if (text) {
				chunks.push(text);
				if (!firstUserMessage) firstUserMessage = text.slice(0, 200);
			}
		} else if (role === "assistant") {
			const text = extractAssistantText(msg.content);
			if (text) chunks.push(text);
		}
	}

	return { chunks, firstUserMessage };
}

function extractText(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text" && block.text) {
			parts.push(block.text);
		}
	}
	return parts.join(" ");
}

function extractAssistantText(content: any): string {
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const block of content) {
		// Skip thinking blocks and tool calls
		if (block.type === "text" && block.text) {
			parts.push(block.text);
		}
	}
	return parts.join(" ");
}

/** Find all session JSONL files. */
function findSessionFiles(sessionsDir: string): { path: string; dirName: string; filename: string }[] {
	const results: { path: string; dirName: string; filename: string }[] = [];

	if (!fs.existsSync(sessionsDir)) return results;

	try {
		const dirs = fs.readdirSync(sessionsDir);
		for (const dir of dirs) {
			const dirPath = path.join(sessionsDir, dir);
			let stat: fs.Stats;
			try {
				stat = fs.statSync(dirPath);
			} catch {
				continue;
			}
			if (!stat.isDirectory()) continue;

			try {
				const files = fs.readdirSync(dirPath);
				for (const file of files) {
					if (!file.endsWith(".jsonl")) continue;
					results.push({
						path: path.join(dirPath, file),
						dirName: dir,
						filename: file,
					});
				}
			} catch {
				continue;
			}
		}
	} catch {
		// sessions dir inaccessible
	}

	return results;
}

/** Yield to the event loop — allows UI to stay responsive during indexing. */
function yieldTick(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/**
 * Read a file asynchronously and extract indexable content.
 * Same logic as extractContent but non-blocking.
 */
async function extractContentAsync(filePath: string): Promise<{ chunks: string[]; firstUserMessage: string | null }> {
	const chunks: string[] = [];
	let firstUserMessage: string | null = null;

	let data: string;
	try {
		data = await fsp.readFile(filePath, "utf-8");
	} catch {
		return { chunks, firstUserMessage };
	}

	const lines = data.split("\n");

	for (const line of lines) {
		if (!line.trim()) continue;

		let entry: any;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}

		if (entry.type !== "message") continue;

		const msg = entry.message;
		if (!msg) continue;

		const role = msg.role;

		if (role === "user") {
			const text = extractText(msg.content);
			if (text) {
				chunks.push(text);
				if (!firstUserMessage) firstUserMessage = text.slice(0, 200);
			}
		} else if (role === "assistant") {
			const text = extractAssistantText(msg.content);
			if (text) chunks.push(text);
		}
	}

	return { chunks, firstUserMessage };
}

const BATCH_SIZE = 20; // files per batch before yielding to event loop
const CHUNK_SIZE = 4000; // characters per FTS row

/**
 * Build or update the FTS index incrementally.
 * Async with cooperative yielding — reads files without blocking the event loop,
 * then writes each batch to SQLite in a transaction.
 * Returns the number of sessions indexed in this run.
 */
export async function updateIndex(onProgress?: (msg: string) => void): Promise<number> {
	const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
	const files = findSessionFiles(sessionsDir);
	const db = getDb();

	// Refresh code dirs cache for accurate project resolution
	resetCodeDirsCache();

	// Get currently indexed sessions with their mtimes
	const indexed = new Map<string, number>();
	const rows = db.prepare("SELECT path, mtime_ms FROM sessions").all() as { path: string; mtime_ms: number }[];
	for (const row of rows) {
		indexed.set(row.path, row.mtime_ms);
	}

	// Find files that need (re-)indexing — use async stat
	const toIndex: typeof files = [];
	const currentPaths = new Set<string>();

	for (const file of files) {
		currentPaths.add(file.path);
		let mtime: number;
		try {
			const stat = await fsp.stat(file.path);
			mtime = stat.mtimeMs;
		} catch {
			continue;
		}

		const lastMtime = indexed.get(file.path);
		if (lastMtime === undefined || mtime > lastMtime) {
			toIndex.push(file);
		}
	}

	// Remove sessions that no longer exist
	const removedPaths: string[] = [];
	for (const [p] of indexed) {
		if (!currentPaths.has(p)) removedPaths.push(p);
	}

	if (removedPaths.length > 0) {
		const deleteSession = db.prepare("DELETE FROM sessions WHERE path = ?");
		const deleteFts = db.prepare("DELETE FROM session_fts WHERE session_path = ?");
		const removeTx = db.transaction(() => {
			for (const p of removedPaths) {
				deleteSession.run(p);
				deleteFts.run(p);
			}
		});
		removeTx();
	}

	if (toIndex.length === 0) {
		onProgress?.("Index up to date");
		return 0;
	}

	onProgress?.(`Indexing ${toIndex.length} session${toIndex.length > 1 ? "s" : ""}...`);

	const upsertSession = db.prepare(`
		INSERT OR REPLACE INTO sessions (path, project, session_ts, mtime_ms, first_user_message)
		VALUES (?, ?, ?, ?, ?)
	`);
	const deleteFts = db.prepare("DELETE FROM session_fts WHERE session_path = ?");
	const insertFts = db.prepare("INSERT INTO session_fts (content, session_path) VALUES (?, ?)");

	// Process in batches: async file reads → sync DB writes → yield
	for (let batchStart = 0; batchStart < toIndex.length; batchStart += BATCH_SIZE) {
		const batchEnd = Math.min(batchStart + BATCH_SIZE, toIndex.length);
		const batch = toIndex.slice(batchStart, batchEnd);

		// Read all files in this batch asynchronously
		const batchData = await Promise.all(
			batch.map(async (file) => {
				let mtime: number;
				try {
					const stat = await fsp.stat(file.path);
					mtime = stat.mtimeMs;
				} catch {
					return null;
				}
				const content = await extractContentAsync(file.path);
				return { file, mtime, ...content };
			})
		);

		// Write batch to DB in a single transaction (fast, sync)
		const writeTx = db.transaction(() => {
			for (const item of batchData) {
				if (!item) continue;

				const { file, mtime, chunks, firstUserMessage } = item;
				const project = projectFromDir(file.dirName);
				const sessionTs = timestampFromFilename(file.filename);

				deleteFts.run(file.path);
				upsertSession.run(file.path, project, sessionTs, mtime, firstUserMessage);

				const combined = chunks.join("\n\n");
				if (!combined.trim()) continue;

				for (let offset = 0; offset < combined.length; offset += CHUNK_SIZE) {
					const slice = combined.slice(offset, offset + CHUNK_SIZE);
					insertFts.run(slice, file.path);
				}
			}
		});
		writeTx();

		if (batchEnd < toIndex.length) {
			onProgress?.(`Indexed ${batchEnd}/${toIndex.length}...`);
			await yieldTick(); // let UI breathe
		}
	}

	// Update meta
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_updated', ?)").run(
		new Date().toISOString()
	);

	onProgress?.(`Indexed ${toIndex.length} session${toIndex.length > 1 ? "s" : ""}`);
	return toIndex.length;
}

/**
 * Drop and rebuild the entire index from scratch.
 * Use for `/search reindex` — guarantees a clean slate.
 */
export async function rebuildIndex(onProgress?: (msg: string) => void): Promise<number> {
	const db = getDb();

	onProgress?.("Clearing index...");
	db.exec("DELETE FROM session_fts");
	db.exec("DELETE FROM sessions");
	db.exec("DELETE FROM meta");

	return updateIndex(onProgress);
}

/**
 * Sanitize a search query into tokens safe for FTS5 MATCH.
 *
 * Strips everything the unicode61 tokenizer treats as separators
 * (anything not a Unicode letter or digit), so inputs like `node.js`,
 * `foo/bar`, `can't`, `hello-world`, `R&D` produce valid tokens.
 */
export function sanitizeTokens(query: string): string[] {
	return query
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);
}

/**
 * Build an FTS5 MATCH query from sanitized tokens.
 * All tokens are quoted for exact match; the last token also gets a
 * prefix wildcard for live-typing partial matching.
 */
export function buildFtsQuery(tokens: string[]): string {
	if (tokens.length === 0) return "";
	return tokens
		.map((t, i) => (i === tokens.length - 1 ? `"${t}"*` : `"${t}"`))
		.join(" ");
}

/** Search sessions. Returns deduplicated results ranked by relevance. */
export function search(query: string, limit = 20): SearchResult[] {
	const db = getDb();

	const tokens = sanitizeTokens(query);
	if (tokens.length === 0) return [];

	const safeQuery = buildFtsQuery(tokens);
	if (!safeQuery) return [];

	// Deduplicate at the SQL level: GROUP BY session_path with best rank,
	// then fetch the snippet from the best-matching chunk via correlated subquery.
	const stmt = db.prepare(`
		WITH best_matches AS (
			SELECT session_path, MIN(rank) as best_rank
			FROM session_fts
			WHERE session_fts MATCH $query
			GROUP BY session_path
			ORDER BY best_rank
			LIMIT $limit
		)
		SELECT
			bm.session_path,
			s.project,
			s.session_ts,
			s.first_user_message,
			bm.best_rank as rank,
			(SELECT snippet(session_fts, 0, '→', '←', '…', 40)
			 FROM session_fts
			 WHERE session_fts MATCH $query AND session_path = bm.session_path
			 ORDER BY rank LIMIT 1) as snippet
		FROM best_matches bm
		JOIN sessions s ON s.path = bm.session_path
		ORDER BY bm.best_rank
	`);

	const raw = stmt.all({ query: safeQuery, limit }) as {
		session_path: string;
		project: string;
		session_ts: string;
		first_user_message: string | null;
		snippet: string;
		rank: number;
	}[];

	return raw.map((row) => ({
		sessionPath: row.session_path,
		project: row.project,
		timestamp: row.session_ts,
		snippet: row.snippet ?? "",
		rank: row.rank,
		title: row.first_user_message,
	}));
}

/** Get all snippets for a session matching a query. */
export function getSessionSnippets(sessionPath: string, query: string, limit = 10): string[] {
	const db = getDb();

	const tokens = sanitizeTokens(query);
	if (tokens.length === 0) return [];

	const safeQuery = buildFtsQuery(tokens);
	if (!safeQuery) return [];

	const stmt = db.prepare(`
		SELECT snippet(session_fts, 0, '→', '←', '…', 60) as snippet
		FROM session_fts
		WHERE session_fts MATCH ? AND session_path = ?
		ORDER BY rank
		LIMIT ?
	`);

	const rows = stmt.all(safeQuery, sessionPath, limit) as { snippet: string }[];
	return rows.map((r) => r.snippet);
}

/** Get the first user message for a session (for display). */
export function getSessionTitle(sessionPath: string): string | null {
	const db = getDb();
	const row = db.prepare("SELECT first_user_message FROM sessions WHERE path = ?").get(sessionPath) as {
		first_user_message: string | null;
	} | undefined;
	return row?.first_user_message ?? null;
}

export function getStats(): IndexStats {
	const db = getDb();
	const sessions = db.prepare("SELECT COUNT(*) as count FROM sessions").get() as { count: number };
	const chunks = db.prepare("SELECT COUNT(*) as count FROM session_fts").get() as { count: number };
	const meta = db.prepare("SELECT value FROM meta WHERE key = 'last_updated'").get() as {
		value: string;
	} | undefined;

	return {
		totalSessions: sessions.count,
		totalChunks: chunks.count,
		lastUpdated: meta?.value ?? null,
	};
}
