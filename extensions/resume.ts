export interface SearchNewContextArgs {
	sessionPath: string;
	customPrompt?: string;
}

// Parse a narrow, command-bar-friendly argument format: one or more
// double-quoted values, with `\"` and `\\` supported inside a quoted value.
//
// We deliberately keep this stricter than shell parsing so the grammar stays
// easy to reason about and the generated command lines are predictable.
function parseDoubleQuotedArgs(input: string): string[] | undefined {
	const values: string[] = [];
	let i = 0;

	while (i < input.length) {
		while (i < input.length && /\s/.test(input[i]!)) i++;
		if (i >= input.length) break;
		if (input[i] !== '"') return undefined;
		i++;

		let value = "";
		let closed = false;
		while (i < input.length) {
			const ch = input[i]!;
			if (ch === '"') {
				closed = true;
				i++;
				break;
			}
			if (ch === "\\") {
				if (i + 1 >= input.length) return undefined;
				const next = input[i + 1]!;
				if (next !== '"' && next !== "\\") return undefined;
				value += next;
				i += 2;
				continue;
			}
			value += ch;
			i++;
		}

		if (!closed) return undefined;
		values.push(value);
		while (i < input.length && /\s/.test(input[i]!)) i++;
	}

	return values;
}

// Parse `/search resume "<sessionPath>"` from the raw subcommand text.
export function parseSearchResumePath(args?: string): string | null {
	const trimmed = args?.trim() ?? "";
	if (!/^resume(?:\s+|$)/.test(trimmed)) return null;

	const rest = trimmed.slice("resume".length).trim();
	if (!rest) return "";

	const values = parseDoubleQuotedArgs(rest);
	if (!values || values.length !== 1) return "";
	return values[0] ?? "";
}

// Parse `/search new-context "<sessionPath>" ["focus prompt"]`.
//
// This subcommand exists so the Ctrl+F path can hand off into a command
// handler, which is the only place pi exposes `ctx.newSession(...)`.
export function parseSearchNewContextArgs(
	args?: string,
): SearchNewContextArgs | null {
	const trimmed = args?.trim() ?? "";
	if (!/^new-context(?:\s+|$)/.test(trimmed)) return null;

	const rest = trimmed.slice("new-context".length).trim();
	if (!rest) return { sessionPath: "" };

	const values = parseDoubleQuotedArgs(rest);
	if (!values || values.length === 0 || values.length > 2) {
		return { sessionPath: "" };
	}

	return {
		sessionPath: values[0] ?? "",
		customPrompt: values[1] || undefined,
	};
}

export function quoteCommandArg(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Build the command line that Ctrl+F drops into the editor for the user to
// confirm. This is the inverse of parseSearchNewContextArgs().
export function buildSearchNewContextCommand(
	sessionPath: string,
	customPrompt?: string,
): string {
	const parts = ["/search", "new-context", quoteCommandArg(sessionPath)];
	if (customPrompt?.trim()) {
		parts.push(quoteCommandArg(customPrompt.trim()));
	}
	return parts.join(" ");
}
