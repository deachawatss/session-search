# session-search — spec

A **Bun/TypeScript** CLI + MCP server that gives Claude Code's session history a **memory
horizon**: every session is bucketed by age into short / mid / long / archive, computed at
query time. It **reads session-viewer's index, read-only, and never writes.**

> **This spec was rewritten on 2026-08-28.** The app was originally justified by real-time
> incremental indexing. That is no longer what it is — see `## What this app is not` below.
> A spec that misdescribes its app is worse than no spec, so the old framing was deleted
> rather than annotated. Git preserves it at `76da69e`.

## Why it exists

session-viewer indexes and searches 31,207 sessions across 11 months extremely well. It has
no concept of **when**. "What was I working on last month" is not a query it can answer, and
age is the axis a human actually navigates their own history by.

That is the whole product. Everything else here is in service of it, or deleted.

## What this app is not

- **Not an indexer.** It creates no database, owns no schema, and writes no rows. `readonly: true`
  makes that structural, not a convention — a write attempt raises *"attempt to write a
  readonly database"*.
- **Not fresher than session-viewer.** A reader cannot outrun its writer. v2 does not fix
  staleness; it **reports** it (see `## Honest staleness` below).
- **Not real-time.** The original design ported `Tail.swift`'s byte-offset tailer for
  write-through FTS. Under the read-only decision that is impossible and was cancelled
  (issues #9/#10/#13 closed).
- **Not a vector/semantic search.** Embeddings stay session-viewer's job.

## Architecture decisions

**Read session-viewer's index rather than build a second one.** That db already unifies both
corpora on this machine — `remote` (28,780 sessions) and `local` (2,427) — so v2 inherits full
coverage for free. Measured before committing: read-only open of the 5.6 GB / 836k-FTS-row
index takes 11 ms, v2's own `SEARCH_EVENTS_TRI` runs against it **unmodified**, and a Thai
mid-word trigram query returns in 85 ms.
Consequence, accepted knowingly: **v2 does not own the schema it reads.** A session-viewer
migration can invalidate `types.ts` with no compile-time signal. That is the standing cost of
not duplicating 5.6 GB.

**Read-only, never shared read-write.** Sharing a writable file was rejected on this fleet's
own precedent — `listen-py`'s SPEC: *"sharing the Swift twin's file would be two writers with
two definitions of embedded; the disease, not the cure."*

**Horizon cut-points are calibrated, not inherited.** LISTEN's 7/30/90 came from vault
memories and is wrong for sessions. Measured against the real 30,810-session index:

| cuts | short | mid | long | archive |
|---|---|---|---|---|
| 7/30/90 (LISTEN's) | 7.2% | 12.8% | **60.4%** | 19.6% |
| **30/60/90 (this)** | **20.0%** | **31.4%** | **29.0%** | **19.6%** |

Measured quartile boundaries are 35.1d / 57.1d / 86.7d, so 30/60/90 is the data-derived
answer rounded to human numbers. A bucket holding 60% of the corpus has not filtered anything.

**Bucket NAMES stay relative (`short/mid/long/archive`), not calendar words.** They keep
LISTEN's vocabulary, and because they name a *rank* rather than a duration, recalibrating the
cuts cannot make them lie. The real cost — `mid` does not tell you it means 30–60 days — is
paid by `horizonLabel()` printing the range in every CLI line and MCP description, not by
renaming and diverging from LISTEN.

**`horizonOf` and `horizonBounds` derive from ONE cut-point table** (`const.ts CUT_DAYS`).
They were two independently-written formulas in LISTEN's first build and disagreed at exact
day-boundaries and on future dates. `selftest` is the drift-lock: 817 assertions that the four
buckets totally partition the timeline, including future-dated and pre-epoch values.

**SQL lives in one file as named constants; every type lives in another.** Ported from
`SQL.swift`'s own reasoning — *"hiding it behind a builder would only obscure the SQL from
schema review and reinvent a worse Drizzle."* Identifiers are never built from variables,
which is why the two search statements are written out in full instead of interpolating a
table name.

**No ORM.** A 6-lens sprint commissioned to adopt Drizzle reversed its own premise: `drizzle-kit
generate` emits a plain `CREATE TABLE` where an FTS5 virtual table was declared, and all three
Drizzle-using sibling oracles (`arra-oracle`, `arra-oracle-v3`, `oracle-v2`) already carve FTS5
out to raw SQL. Peer precedent the same week, haos-oracle#2: *"keep raw SQL — simple first."*

## Honest staleness

v2 cannot refresh the index, so it must never silently serve stale data — that would recreate,
one layer up, the exact bug that motivated this project. Every command and every MCP tool
response ends with a staleness line read from `import_runs`:

```
· index last imported 12h ago
⚠ index last imported 4d ago — run `session-viewer import` to refresh
```

`search` prints it on zero results specifically, because *"no matches"* and *"no matches yet,
the index is four days old"* are different answers.

## Constraints

- **FTS5 trigram is non-negotiable.** Thai has no inter-word spaces; measured on this corpus
  unicode61 scores 0–40% recall on Thai queries against trigram's 100%. Trigram cannot match
  needles under 3 characters, so queries route by length (`TRIGRAM_MIN_CHARS`).
- **No prefix wildcard on the trigram path.** Trigram already matches substrings; adding `*`
  measured `"work"*` → 4527 rows against a truth of 771.
- **Bucketing is by session START, not last write.** A session begun in May and appended to
  today lands in `archive`. Defensible (it is when the work happened) but not obviously right —
  recorded as a known semantic, not a settled one.
- **`libSQL` was tested and works** (ships FTS5+trigram, byte-compatible with stock sqlite3) —
  not adopted because nothing here needs replication. The reason is "no need", not "unknown".

## Surfaces

| CLI verb | MCP tool | |
|---|---|---|
| `horizons` | `horizons` | distribution across all four buckets |
| `list --horizon B` | `list_by_horizon` | sessions in one bucket, newest first |
| `search Q` | `search_sessions` | FTS5, trigram-routed, Thai-safe |
| `status` | `index_status` | contents + staleness |
| `selftest` | — | horizon partition drift-lock |
| `mcp` | — | stdio server |

MCP protocol version is **negotiated**, never hardcoded — both LISTEN twins shipped broken by
replying their own modern constant while the real client asks for `2025-11-25`. This is the
third implementation of that fix in this fleet; it is here from the start so there is no fourth.

---
DNA lenses: Archaeologist, Mechanic, Skeptic, User, Architect, Minimalist (Workflow, haiku) ·
`/oracle-prism` design pass (User, Maintainer, Breaker, Simplifier, Integrator) ·
2026-08-27 → 2026-08-28
