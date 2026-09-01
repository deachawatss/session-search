# session-search — todo

Status as of 2026-08-28. `[x]` means verified by running it, not by assuming.
Tracking: TODO.md + GitHub issues (#7 epic).

## Done — verified

- [x] **DNA sprint** (6 lenses) + live verification of the staleness claim that motivated
      the project. Verified: `index_status` → "pending 60 new · 17 changed";
      `search_sessions("session-search")` → "No matches" while that session was being
      written; `ψ/ralph/session-viewer.md:146` confirms the separate Write-tool extraction gap.

- [x] **Stack: Bun/TypeScript** (not Swift). Verified: `bun:sqlite` bundles SQLite 3.51.0,
      FTS5 `tokenize='trigram'` confirmed with a genuine mid-word Thai match.

- [x] **No ORM** (#7). A sprint commissioned to adopt Drizzle reversed its own premise.
      Verified: `drizzle-kit generate` emits plain `CREATE TABLE` where an FTS5 virtual table
      was declared; `@libsql/client` 0.17.4 DOES ship FTS5+trigram byte-compatibly (clearing
      session-viewer's long-standing blocker, #14). Decider: all three Drizzle-using sibling
      oracles already carve FTS5 out to raw SQL.

- [x] **Three-file split** `sql.ts` / `const.ts` / `types.ts` (#8, `76da69e`). Fixed real
      drift: `SEARCH_EVENTS` had been defined in two files and `sql.ts` was orphaned.

- [x] **Read-only over session-viewer's index** (#17 → 4a, #19). v2 builds no index.
      Verified: readonly open of the 5.6 GB / 836k-row db → 31,207 sessions in 11ms; v2's own
      `SEARCH_EVENTS_TRI` ran **unmodified** against session-viewer's schema (3 Thai hits,
      85ms); a write attempt was correctly refused. Deleted `import.ts`, `diff.ts`,
      `discover.ts`, `parse.ts`, `schema.sql` rather than leaving them as dead code.
      Surprise: session-viewer's db already unified BOTH corpora (`remote` 28,780 + `local` 2,427),
      so #17's root-coverage problem evaporated instead of needing a solution.

- [x] **Horizon cut-points recalibrated** 7/30/90 → **30/60/90** (#18).
      Verified live: `bun src/cli.ts horizons` → short 20.0% · mid 31.4% · long 29.0% ·
      archive 19.6%. Previously `long` held 60.4%. Measured quartiles 35.1/57.1/86.7d confirm
      30/60/90 is the data-derived answer rounded to human numbers.
      Decision: names stay `short/mid/long/archive` (relative, so recalibration cannot make
      them lie); legibility paid by `horizonLabel()` printing ranges everywhere.

- [x] **Horizon partition drift-lock.** Verified: `bun src/cli.ts selftest` → 817 assertions
      passed — every bucket's own bounds classify back to itself, and a dense sweep from -5d
      to +400d lands in exactly one bucket.

- [x] **Horizon listing + honest staleness** (#15 rescoped). Verified: `list --horizon short`
      → 6160 sessions; `list --horizon archive` → 6033, oldest 2026-05-29. Every command ends
      with a real `import_runs`-derived line ("· index last imported 12h ago").

- [x] **MCP server, protocol version NEGOTIATED** (#11). Verified end-to-end over stdio:
      client asking `2025-11-25` → server agrees `2025-11-25`; an unsupported `1999-01-01`
      falls back to `2025-11-25` rather than failing; `tools/list` → 4 tools; all four
      `tools/call` return `resultType: "complete"`. Registered and live:
      `claude mcp list` → `session-search: ✔ Connected`.

- [x] **`read_context` — the search→context loop closes.** `search` now returns navigable
      `#id:seq`; `context`/`read_context` shows the exchange around it.
      Verified end-to-end on a real hit: searching `กระจกไม่แกล้ง` found `#5438:2103`
      ("why not direct? why...") — a snippet that cannot answer its own question. Context
      revealed seq 2106: *"Good point. The mirror metaphor adds unnecessary indirection...
      Want me to change it to 'AI ไม่แกล้งเป็นคน บอกตรงๆ ว่าเป็น AI'"*. Found WHERE, showed WHAT.
      Verified over MCP too: `tools/list` → 5 tools, `read_context` returns
      `resultType=complete, isError=false`.
      **Reads the source .jsonl, not the index** — measured: querying `events_fts` by
      session_id+seq took **9,900ms** (FTS5 `UNINDEXED` columns are stored but not indexed,
      so it full-scans 836k rows); reading the transcript takes **2ms**, and `context` end to
      end runs in **37ms**. Verified the seq contract matches exactly: FTS seq 100 for
      session 318 is the 100th non-empty line of its file.
      Surprise: **`session_uuid` is NOT unique** — a top-level session shares its uuid with
      every subagent and workflow transcript beneath it (`c80b8013` matched **172** others).
      Resolution prefers the `session` tier and REPORTS the ambiguity rather than silently
      picking one; `id` is the unambiguous locator and is what `search` now prints.

- [x] **Duplicate hits deduped.** Was: searching `ระจก` returned the identical
      `[600de3a0] user` line twice. Now keyed on `(session_id, seq)`.

- [x] **`version` — a calver-style build stamp: `v{yy}.{m}.{d}-{HMM}`.** Same scheme as this
      fleet's `/calver`, HMM = H*100+M off the last commit that touched this app, TZ pinned
      to Asia/Bangkok. Deliberately NOT wall-clock-at-invocation — a version that changes
      every minute the tool merely runs would be a clock, not a version. Wired into
      `serverInfo.version` (so an MCP client can see exactly which build it's talking to —
      the direct answer to a stale-registration question) and into `status`'s header line.
      Verified: `bun src/cli.ts version` → `v26.8.28-1052`, matches
      `TZ=Asia/Bangkok git log -1 --date=format-local:%H:%M` on the same commit exactly.

- [x] **MCP error-signaling test pass — 3 real bugs found and fixed.** Ran every tool with
      both valid and invalid input over real JSON-RPC. Found: an unknown tool name, an
      unknown horizon bucket, and an empty search query all returned `isError: false` —
      claiming success while reporting a caller mistake. All three now `throw` instead of
      returning text, routing through the existing error path.
      Verified: 9/9 assertions — every valid call `isError:false`, every invalid call
      `isError:true`, including the read_context "no session matches" case which was
      already correct and served as the reference the other three were brought in line with.

## Next — not started

- [ ] Filtered search — `--project`, `--tier`, `--since`/`--until`. session-viewer's
      `searchEventsFiltered` (`Store.swift:640`) is the direct model. Note the Simplifier
      lens's argument that `--since`/`--until` ranges may make horizon buckets redundant;
      worth testing which one is actually reached for.

## Open questions

- **Bucket by session START or last write?** Currently START. A session begun in May and
  appended to today lands in `archive`. Defensible — it is when the work happened — but a
  human asking "what have I touched recently" may mean last-write. Not settled; recorded in
  SPEC.md as a known semantic rather than a decided one.

- **Do horizon buckets survive contact with `--since`/`--until`?** If ranges turn out to be
  what gets used, the buckets are sugar over a primitive and could be dropped. Test by use,
  not argument.

## Deferred — decided, not scheduled

- [ ] Real-time indexing, watcher daemon, write concurrency (#9/#10/#13, all CLOSED).
      Impossible under read-only and cancelled with it. Reopen only if v2 ever owns an index.

- [ ] Vectors / semantic search. session-viewer's job. If ever revisited here, the cheap shape
      is haos-oracle#2's: `embeddinggemma:300m` via local Ollama, one `embedding BLOB` column,
      brute-force cosine. **Unverified assumption to test first**: does anyone search
      semantically for recent content, or is that need FTS-shaped?

- [ ] libSQL. Proven to work (#14) but not needed — nothing here requires replication.

- [ ] Fixing session-viewer's Write-tool FTS-extraction gap. Its bug, not this app's.
