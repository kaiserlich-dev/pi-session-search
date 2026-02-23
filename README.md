# pi-session-search

Full-text search across all pi sessions with a SQLite FTS5 index and overlay UI.

## Features

- **FTS5 index** — indexes user messages, assistant responses, and session metadata. Sub-100ms queries regardless of session count.
- **Incremental indexing** — only processes new/changed sessions. Runs in background on startup.
- **Overlay search palette** — same look as pi-skill-picker / pi-queue-picker.
- **Preview** — see matched snippets with highlighted terms before deciding.
- **Resume** — switch to a found session directly.
- **Summarize & inject** — ask the LLM to read the full session and inject a summary into your current context.

## Usage

| Shortcut / Command | Action |
|---|---|
| `Ctrl+F` | Open search overlay |
| `/search` | Open search overlay |
| `/search reindex` | Force full reindex |
| `/search stats` | Show index statistics |

### In the overlay

| Key | Action |
|---|---|
| Type | Search query (debounced) |
| `↑` / `↓` | Navigate results |
| `Enter` | Preview matched snippets |
| `R` | Resume selected session |
| `S` | Summarize & inject into current session |
| `Esc` | Close |

## Install

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "/path/to/pi-session-search"
  ]
}
```

Then restart pi or run `/reload`.

## How it works

1. On `session_start`, the indexer scans `~/.pi/agent/sessions/` for JSONL files.
2. Files with a newer `mtime` than last indexed are parsed — user messages and assistant text (no thinking blocks) are extracted.
3. Text is chunked into ~4KB segments and inserted into a SQLite FTS5 table with Porter stemming.
4. Searches use FTS5 `MATCH` with BM25 ranking, deduplicated per session.
5. The index lives at `~/.pi-session-search/index.db` (~5-10MB for hundreds of sessions).
