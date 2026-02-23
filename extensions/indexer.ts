/**
 * Session indexer — SQLite FTS5 index for pi session JSONL files.
 *
 * Extracts user messages, assistant text (no thinking), and session metadata.
 * Incremental: only re-indexes files whose mtime changed since last indexed.
 */

import Database from "better-sqlite3";
import * as fs from "node:fs";
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

/** Derive a human-readable project name from the session directory path. */
function projectFromDir(dirName: string): string {
	// dirName is like "--Users-julian-code-kaiserlich-dev-festung--"
	// Strip leading/trailing --
	let clean = dirName.replace(/^--/, "").replace(/--$/, "");
	// Replace - with /
	clean = clean.replace(/-/g, "/");
	// Try to extract the meaningful part after "code/"
	const codeIdx = clean.indexOf("code/");
	if (codeIdx >= 0) {
		return clean.slice(codeIdx + 5);
	}
	// Try after home dir
	const homeDir = os.homedir().replace(/\//g, "/");
	const homeClean = homeDir.replace(/^\//, "");
	if (clean.startsWith(homeClean)) {
		const rest = clean.slice(homeClean.length).replace(/^\//, "");
		return rest || "~";
	}
	return clean || "unknown";
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

/**
 * Build or update the FTS index incrementally.
 * Returns the number of sessions indexed in this run.
 */
export function updateIndex(onProgress?: (msg: string) => void): number {
	const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
	const files = findSessionFiles(sessionsDir);
	const db = getDb();

	// Get currently indexed sessions with their mtimes
	const indexed = new Map<string, number>();
	const rows = db.prepare("SELECT path, mtime_ms FROM sessions").all() as { path: string; mtime_ms: number }[];
	for (const row of rows) {
		indexed.set(row.path, row.mtime_ms);
	}

	// Find files that need (re-)indexing
	const toIndex: typeof files = [];
	const currentPaths = new Set<string>();

	for (const file of files) {
		currentPaths.add(file.path);
		let mtime: number;
		try {
			mtime = fs.statSync(file.path).mtimeMs;
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

	const CHUNK_SIZE = 4000; // characters per FTS row — keeps snippets reasonable

	const indexTx = db.transaction(() => {
		for (let i = 0; i < toIndex.length; i++) {
			const file = toIndex[i];
			const project = projectFromDir(file.dirName);
			const sessionTs = timestampFromFilename(file.filename);

			let mtime: number;
			try {
				mtime = fs.statSync(file.path).mtimeMs;
			} catch {
				continue;
			}

			const { chunks, firstUserMessage } = extractContent(file.path);

			// Remove old FTS entries for this session
			deleteFts.run(file.path);

			// Insert session metadata
			upsertSession.run(file.path, project, sessionTs, mtime, firstUserMessage);

			// Combine chunks and split into FTS rows of ~CHUNK_SIZE chars
			const combined = chunks.join("\n\n");
			if (!combined.trim()) continue;

			for (let offset = 0; offset < combined.length; offset += CHUNK_SIZE) {
				const slice = combined.slice(offset, offset + CHUNK_SIZE);
				insertFts.run(slice, file.path);
			}

			if ((i + 1) % 50 === 0) {
				onProgress?.(`Indexed ${i + 1}/${toIndex.length}...`);
			}
		}
	});

	indexTx();

	// Update meta
	db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('last_updated', ?)").run(
		new Date().toISOString()
	);

	onProgress?.(`Indexed ${toIndex.length} session${toIndex.length > 1 ? "s" : ""}`);
	return toIndex.length;
}

/** Search sessions. Returns deduplicated results ranked by relevance. */
export function search(query: string, limit = 20): SearchResult[] {
	const db = getDb();

	// FTS5 query — escape special chars, prefix-match last token for live typing
	const tokens = query
		.replace(/[":(){}[\]^~*]/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);

	if (tokens.length === 0) return [];

	// All tokens exact, last token also gets prefix * for partial matching
	const safeQuery = tokens
		.map((t, i) => (i === tokens.length - 1 ? `${t}*` : `"${t}"`))
		.join(" ");

	if (!safeQuery) return [];

	const stmt = db.prepare(`
		SELECT
			f.session_path,
			s.project,
			s.session_ts,
			snippet(session_fts, 0, '→', '←', '…', 40) as snippet,
			rank
		FROM session_fts f
		JOIN sessions s ON s.path = f.session_path
		WHERE session_fts MATCH ?
		ORDER BY rank
		LIMIT ?
	`);

	const raw = stmt.all(safeQuery, limit * 3) as {
		session_path: string;
		project: string;
		session_ts: string;
		snippet: string;
		rank: number;
	}[];

	// Deduplicate by session path (keep best rank per session)
	const seen = new Map<string, SearchResult>();
	for (const row of raw) {
		if (!seen.has(row.session_path)) {
			seen.set(row.session_path, {
				sessionPath: row.session_path,
				project: row.project,
				timestamp: row.session_ts,
				snippet: row.snippet,
				rank: row.rank,
			});
		}
	}

	return Array.from(seen.values()).slice(0, limit);
}

/** Get all snippets for a session matching a query. */
export function getSessionSnippets(sessionPath: string, query: string, limit = 10): string[] {
	const db = getDb();

	const tokens = query
		.replace(/[":(){}[\]^~*]/g, " ")
		.trim()
		.split(/\s+/)
		.filter(Boolean);

	if (tokens.length === 0) return [];

	const safeQuery = tokens
		.map((t, i) => (i === tokens.length - 1 ? `${t}*` : `"${t}"`))
		.join(" ");

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
