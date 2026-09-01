// const.ts — tuning values and resolved paths. One home for every magic number, so a
// value that was measured (not guessed) carries its measurement next to it.

// MARK: - the index this app READS
//
// session-search does not build an index. It reads session-viewer's, open read-only.
// Set SESSION_VIEWER_DB (or pass --db) to point at a local index; no corpus is bundled.
// This keeps the reader portable and gives it no implicit access to another checkout.
export const DEFAULT_DB =
  process.env.SESSION_VIEWER_DB ?? `${process.env.HOME ?? "."}/.session-viewer/sessions.db`;

// MARK: - search

/// Shortest query the trigram index can answer. FTS5's trigram tokenizer indexes 3-char
/// sequences, so a 1- or 2-character needle has no trigram to match and returns ZERO.
/// Measured on this corpus: `9c` against trigram = 0 rows, against unicode61-with-prefix = 3.
export const TRIGRAM_MIN_CHARS = 3;

export const DEFAULT_SEARCH_LIMIT = 20;

export const SEARCH_TIERS = ["session", "subagent", "workflow_agent"] as const;
export const SEARCH_SOURCES = ["claude", "codex"] as const;

// MARK: - horizons
//
// The ONE cut-point table. Both `horizonOf` and `horizonBounds` derive from this by
// construction — they were two independently-written formulas in LISTEN's first build and
// disagreed at exact day-boundaries and on future dates. Sharing the numbers makes that
// defect class impossible: there is only one place to edit.
//
// CALIBRATED, not inherited. LISTEN's original 7/30/90 came from vault memories and is
// wrong for sessions: measured against the real 30,810-session index it put 60.4% of
// everything in `long` and 7.2% in `short` — a filter that returns three-fifths of the
// corpus has not filtered. Measured quartile boundaries here are 35.1d / 57.1d / 86.7d,
// so 30/60/90 is the data-derived answer rounded to human numbers:
//
//     cuts          short   mid    long   archive
//     7/30/90        7.2%  12.8%  60.4%   19.6%   <- LISTEN's, badly skewed
//     30/60/90      20.0%  31.4%  29.0%   19.6%   <- this
//
// The NAMES stay relative (short/mid/long/archive) rather than becoming calendar words:
// they keep LISTEN's vocabulary, and because they name a *rank* rather than a duration,
// re-calibrating the cuts cannot make them lie. The cost — that "mid" does not tell you
// it means 30-60 days — is paid by printing the real ranges in `horizonLabel()` and in
// every CLI/MCP description, not by renaming.
export const CUT_DAYS = { short: 30, mid: 60, long: 90 } as const;

export const SECONDS_PER_DAY = 86_400;

/// Sentinels, not caps — they exist so the four buckets are TOTAL over any epoch,
/// including future-dated and pre-1970 rows.
export const FAR = 2 ** 60;
