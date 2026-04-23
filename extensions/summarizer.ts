import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { SearchResult } from "./indexer";
import { formatDate } from "./types";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
export const MODEL = "google/gemini-3-flash-preview";
// pi-session-search manages its own small secrets file for now instead of
// wiring through pi's provider settings. `/session-search-register-key` writes
// this file locally for the user.
export const SECRETS_PATH = path.join(
	os.homedir(),
	".session-search",
	"secrets.json",
);

let _apiKey: string | null = null;

export function getApiKey(): string {
	if (_apiKey) return _apiKey;
	try {
		const secrets = JSON.parse(fs.readFileSync(SECRETS_PATH, "utf-8"));
		_apiKey = secrets.apiKey;
		return _apiKey!;
	} catch {
		throw new Error(
			`No API key found at ${SECRETS_PATH}. Run /session-search-register-key, or create that file with {"apiKey":"YOUR_OPENROUTER_API_KEY"}.`,
		);
	}
}

// Persist the OpenRouter key in the simple file format this extension expects.
// Returning the path keeps the command handler's success message straightforward.
export function setApiKey(apiKey: string): string {
	fs.mkdirSync(path.dirname(SECRETS_PATH), { recursive: true });
	fs.writeFileSync(
		SECRETS_PATH,
		`${JSON.stringify({ apiKey }, null, 2)}\n`,
		"utf-8",
	);
	try {
		fs.chmodSync(SECRETS_PATH, 0o600);
	} catch {
		// Best-effort permission tightening; ignore on unsupported platforms.
	}
	_apiKey = apiKey;
	return SECRETS_PATH;
}

/**
 * Extract a clean text transcript from a session JSONL file.
 *
 * This deliberately keeps the summarizer away from raw JSONL noise. We only
 * feed user/assistant text to Gemini, not the whole structured session file.
 */
export function extractSessionText(sessionPath: string): string {
	const data = fs.readFileSync(sessionPath, "utf-8");
	const lines = data.split("\n");
	const parts: string[] = [];

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

		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: (msg.content || [])
							.filter((c: any) => c.type === "text")
							.map((c: any) => c.text)
							.join(" ");
			if (text.trim()) parts.push(`[USER] ${text.trim()}`);
		} else if (msg.role === "assistant") {
			const text = (msg.content || [])
				.filter((c: any) => c.type === "text")
				.map((c: any) => c.text)
				.join(" ");
			if (text.trim()) parts.push(`[ASSISTANT] ${text.trim()}`);
		}
	}

	return parts.join("\n\n");
}

/**
 * Summarize a session via Gemini Flash through OpenRouter.
 *
 * The summarizer is intentionally simple: extract a lightweight transcript,
 * optionally add a focus prompt, then make one completion request.
 */
export async function summarizeSession(
	session: SearchResult,
	focusPrompt?: string,
): Promise<string> {
	const text = extractSessionText(session.sessionPath);
	if (!text.trim())
		return "Empty session — no user or assistant messages found.";

	const project = session.project;
	const date = formatDate(session.timestamp);

	const systemParts = [
		`You summarize coding agent sessions. Be concise but thorough.`,
		`Use markdown headings for distinct topics.`,
		`Focus on: key decisions, outcomes, what was built/fixed/configured,`,
		`and important context someone continuing this work would need.`,
	];
	if (focusPrompt) {
		systemParts.push(
			`The user specifically wants you to focus on: ${focusPrompt}`,
		);
	}
	const systemPrompt = systemParts.join(" ");

	const userPrompt = [
		`Project: ${project} | Date: ${date}`,
		``,
		`Summarize this session:`,
		``,
		text,
	].join("\n");

	const response = await fetch(OPENROUTER_URL, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${getApiKey()}`,
		},
		body: JSON.stringify({
			model: MODEL,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
			max_tokens: 4096,
		}),
	});

	if (!response.ok) {
		const err = await response.text();
		throw new Error(`OpenRouter ${response.status}: ${err.slice(0, 200)}`);
	}

	const json = (await response.json()) as any;
	return (
		json.choices?.[0]?.message?.content?.trim() ?? "No summary generated."
	);
}
