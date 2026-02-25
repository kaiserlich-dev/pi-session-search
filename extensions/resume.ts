export function parseSearchResumePath(args?: string): string | null {
	const trimmed = args?.trim() ?? "";
	if (!/^resume(?:\s+|$)/.test(trimmed)) return null;

	const rest = trimmed.slice("resume".length).trim();
	if (!rest) return "";

	if (
		(rest.startsWith('"') && rest.endsWith('"')) ||
		(rest.startsWith("'") && rest.endsWith("'"))
	) {
		return rest.slice(1, -1);
	}

	return rest;
}

export function quoteCommandArg(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
