# Filtered session search — implementation report

`session-search` is the read-only query layer for a local `session-viewer` SQLite
index. This public repository contains source and tests only; no session index,
JSONL transcript, or machine-specific path is included.

## Built

- Fixed SQL projections for unicode61 and trigram FTS5 search.
- Composable project, tier, source, since, and until filters with bound values.
- Stable `session id + seq` cursors for context navigation.
- CLI and MCP surfaces derived from the same filter validation.
- Horizon bucketing from one cut-point table, with explicit staleness output.

## Verification commands

Run from this directory against a database you choose:

```bash
bun install
bunx tsc --noEmit
bun src/cli.ts selftest
bun src/cli.ts search "กระจก" --db "$SESSION_VIEWER_DB"
bun src/cli.ts horizons --db "$SESSION_VIEWER_DB"
```

The final two commands require a local `session-viewer` index and are never run
by the public Worker. The Worker tests exercise deterministic synthetic response
shapes without opening SQLite.

## Boundary

The index owner imports and writes; this package only reads. Context windows
stream the original transcript after search has identified a cursor. The public
fixture demonstrates this contract without receiving a path or persisting a
request.
