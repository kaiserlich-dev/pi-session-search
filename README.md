# @kaiserlich-dev/pi-session-search

Full-text search across all [pi](https://github.com/mariozechner/pi) sessions with a SQLite FTS5 index and overlay UI.

## Install

### npm (recommended)

```bash
pi install npm:@kaiserlich-dev/pi-session-search
```

### git (alternative)

```bash
pi install git:github.com/kaiserlich-dev/pi-session-search
```

> By default this writes to `~/.pi/agent/settings.json`. Use `-l` to install into `.pi/settings.json` for a project.

Then restart pi or run `/reload`.

## Features

- **FTS5 index** — indexes user messages, assistant responses, tool results, and session metadata. Sub-100ms queries regardless of session count.
- **Browse recent sessions** — opening search shows your most recent sessions immediately, no typing required.
- **Incremental indexing** — only processes new/changed sessions. Runs async in background on startup with cooperative yielding.
- **Overlay search palette** — theme-aware UI matching pi-skill-picker / pi-queue-picker style.
- **Preview** — see matched snippets with highlighted search terms before deciding.
- **Resume** — switch to a found session directly from the preview.
- **Summarize & inject** — ask the LLM to read the full session and inject a summary into your current context.
- **Custom focus prompt** — optionally provide a focus (e.g. "focus on the auth decisions") before summarizing, so the summary targets what you care about.
- **New session with context** — start a fresh session with summarized context from a previous one.
- **Smart project names** — resolves `~/code/owner/repo` paths into readable `owner/repo` project labels.

## Usage

| Shortcut / Command | Action |
|---|---|
| `Ctrl+F` | Open search overlay |
| `/search` | Open search overlay |
| `/search reindex` | Clear and rebuild index from scratch |
| `/search stats` | Show index statistics |

### Search screen

| Key | Action |
|---|---|
| Type | Search query (debounced) |
| `←` / `→` | Move cursor within query |
| `Home` / `Ctrl+A` | Jump to start of query |
| `End` / `Ctrl+E` | Jump to end of query |
| `Delete` | Delete character after cursor |
| `Ctrl+W` / `Alt+Backspace` | Delete word before cursor |
| Paste | Insert clipboard text at cursor |
| `↑` / `↓` | Navigate results |
| `Enter` | Open preview for selected result |
| `Esc` | Close |

When opened with an empty query, recent sessions are shown (most recent first).

### Preview screen

| Key | Action |
|---|---|
| `Tab` / `←` `→` | Cycle actions: Resume · Summarize · New + Context · Back |
| `Enter` | Execute selected action |
| `Esc` | Back to search |

### Summary Focus screen

When choosing **Summarize** or **New + Context**, a prompt screen appears:

| Key | Action |
|---|---|
| `Enter` | Use default summary (no custom focus) |
| Type + `Enter` | Summarize with custom focus prompt |
| `Esc` | Back to preview |

The custom focus is passed to the LLM alongside the session content, steering the summary toward what matters to you.

## How it works

1. On `session_start`, the indexer scans `~/.pi/agent/sessions/` for JSONL files.
2. Files with a newer `mtime` than last indexed are parsed — user messages, assistant text (no thinking blocks), and tool results are extracted.
3. Text is chunked into ~4KB segments and inserted into a SQLite FTS5 table with Porter stemming.
4. Searches use FTS5 `MATCH` with BM25 ranking, deduplicated per session at the SQL level.
5. The index lives at `~/.pi-session-search/index.db` (~5–10MB for hundreds of sessions).
6. Summaries are generated via OpenRouter (Gemini Flash) and injected as assistant messages.

## Development

```bash
# Run locally without installing
pi -e ./extensions/index.ts
```
