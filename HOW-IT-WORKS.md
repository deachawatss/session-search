# How session-search works

`session-search` is the read side of the session toolchain. `session-viewer`
imports Claude/Codex JSONL into a local SQLite index; this package opens that
file read-only and answers queries without a second index.

1. `Db` opens the path from `--db` or `SESSION_VIEWER_DB` with read-only flags.
2. `searchEventsFiltered` selects one fixed SQL statement: unicode61 for short
   needles, trigram for needles of three or more characters.
3. Filter values are bound parameters; the project, tier, source, and time
   predicates are appended from fixed fragments only.
4. Hits carry `sessionId` and the 1-based non-empty-line `seq`.
5. `context` resolves that cursor and streams the original JSONL file around it;
   the index remains untouched.
6. `horizons` and `list` calculate short/mid/long/archive from session start time
   and report the last import timestamp so stale results are explicit.

The public Cloudflare Worker is not this local reader. It is a deterministic
fixture that demonstrates the response shape and UI without receiving a path,
opening SQLite, or persisting a request.
