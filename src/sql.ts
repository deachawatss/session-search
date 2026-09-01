// sql.ts — every SQL statement in the app, as named constants. STRINGS ONLY: the
// bind-parameter tuples and row shapes that go with them live in types.ts.
//
// READ statements only. v2 opens session-viewer's index read-only and owns no schema —
// the write statements that were here (INSERT/UPDATE/DELETE for the ingest path) were
// deleted along with the ingest modules when v2 became a reader. They remain in git at
// 76da69e if that decision is ever reversed.
//
// Ported from session-viewer's SQL.swift, including its reasoning:
//
//   "Deliberately NOT a query builder/factory: every statement here is fixed and uses
//    bound parameters, so hiding it behind a builder would only obscure the SQL from
//    schema review and reinvent a worse Drizzle."
//
// Identifiers are NEVER built from variables. That is why the two search statements are
// written out in full rather than interpolating a table name, and why the trigram variant
// carries its own snippet window (96 vs 16 — trigram tokens are 3-char sequences, not
// words, so 16 of them spans only ~18 characters, measured too narrow to show the phrase
// that was searched for).

// MARK: - search

/// The `as snippet` / `as score` aliases are load-bearing: they let ONE row interface
/// (types.ts `SearchRow`) serve both statements, which is what keeps the two projections
/// from drifting apart.
export const SEARCH_EVENTS = `
  SELECT e.session_id, s.session_uuid, e.role, e.ts, e.seq,
         snippet(events_fts, 4, '«', '»', '…', 16) as snippet, bm25(events_fts) as score
  FROM events_fts e JOIN sessions s ON s.id = e.session_id
  WHERE events_fts MATCH ? ORDER BY bm25(events_fts) LIMIT ?
`;

export const SEARCH_EVENTS_TRI = `
  SELECT e.session_id, s.session_uuid, e.role, e.ts, e.seq,
         snippet(events_fts_tri, 4, '«', '»', '…', 96) as snippet, bm25(events_fts_tri) as score
  FROM events_fts_tri e JOIN sessions s ON s.id = e.session_id
  WHERE events_fts_tri MATCH ? ORDER BY bm25(events_fts_tri) LIMIT ?
`;

/// Filtered-search bases deliberately stop before ORDER BY/LIMIT. search.ts appends only
/// fixed literal fragments selected by booleans; every caller-provided value stays bound.
export const SEARCH_EVENTS_BASE = `
  SELECT e.session_id, s.session_uuid, e.role, e.ts, e.seq,
         snippet(events_fts, 4, '«', '»', '…', 16) as snippet, bm25(events_fts) as score
  FROM events_fts e JOIN sessions s ON s.id = e.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE events_fts MATCH ?
`;

export const SEARCH_EVENTS_TRI_BASE = `
  SELECT e.session_id, s.session_uuid, e.role, e.ts, e.seq,
         snippet(events_fts_tri, 4, '«', '»', '…', 96) as snippet, bm25(events_fts_tri) as score
  FROM events_fts_tri e JOIN sessions s ON s.id = e.session_id
  JOIN projects p ON p.id = s.project_id
  WHERE events_fts_tri MATCH ?
`;

export const SEARCH_PROJECT_FILTER = " AND (p.cwd LIKE ? OR p.dir_name LIKE ?)";
export const SEARCH_TIER_FILTER = " AND s.file_tier = ?";
export const SEARCH_SOURCE_FILTER = " AND s.source = ?";
export const SEARCH_SINCE_FILTER = " AND s.started_at >= ?";
export const SEARCH_UNTIL_FILTER = " AND s.started_at <= ?";
export const SEARCH_EVENTS_ORDER = " ORDER BY bm25(events_fts) LIMIT ?";
export const SEARCH_EVENTS_TRI_ORDER = " ORDER BY bm25(events_fts_tri) LIMIT ?";

// MARK: - status

export const COUNT_SESSIONS = "SELECT COUNT(*) as n FROM sessions";
export const COUNT_SESSIONS_BY_TIER =
  "SELECT file_tier, COUNT(*) as n FROM sessions GROUP BY file_tier";
export const COUNT_SESSIONS_BY_STATUS =
  "SELECT import_status, COUNT(*) as n FROM sessions GROUP BY import_status";
export const SESSION_DATE_RANGE =
  "SELECT MIN(started_at) as minTs, MAX(started_at) as maxTs FROM sessions";

/// Staleness. v2 cannot refresh the index, but it must never silently serve stale data —
/// that would recreate, one layer up, the exact bug this app was created to surface.
export const LAST_IMPORT_RUN = `
  SELECT started_at, finished_at, files_scanned, files_new, files_changed
  FROM import_runs ORDER BY id DESC LIMIT 1
`;

// MARK: - horizon listing
//
// Bounds are computed in TypeScript (horizon.ts) and bound as parameters rather than
// expressed as SQL date arithmetic. That is deliberate: it keeps ONE implementation of
// the cut-points — the same `horizonBounds` the CLI and MCP use — instead of a second,
// silently-diverging copy written in julianday().

/// Sessions whose start falls inside an epoch-second window, newest first.
/// `started_at` is an ISO-8601 string, so it is converted with strftime('%s') rather than
/// compared as text — text comparison would work for same-format rows but breaks silently
/// on any row with a different precision or offset.
export const SESSIONS_IN_WINDOW = `
  SELECT s.id, s.session_uuid, s.file_tier, s.started_at, s.ended_at,
         s.event_count, s.description, p.cwd, p.dir_name
  FROM sessions s JOIN projects p ON p.id = s.project_id
  WHERE s.started_at IS NOT NULL AND s.started_at != ''
    AND CAST(strftime('%s', s.started_at) AS INTEGER) BETWEEN ? AND ?
  ORDER BY s.started_at DESC
  LIMIT ?
`;

export const COUNT_SESSIONS_IN_WINDOW = `
  SELECT COUNT(*) as n FROM sessions
  WHERE started_at IS NOT NULL AND started_at != ''
    AND CAST(strftime('%s', started_at) AS INTEGER) BETWEEN ? AND ?
`;

// MARK: - session locator (for read_context and read_session)
//
// `session_uuid` is NOT unique: a top-level session shares its uuid with every subagent and
// workflow-agent transcript beneath it (measured: `c80b8013` matches 173 rows). Only `id`
// and `file_path` identify a transcript. Both statements below return `file_path` because
// context is read from the source file, not the index — see context.ts for the measurement.

export const SELECT_SESSION_BY_ID = `
  SELECT s.id, s.session_uuid, s.file_tier, s.file_path, p.cwd, p.dir_name
  FROM sessions s JOIN projects p ON p.id = s.project_id
  WHERE s.id = ?
`;

export const SELECT_SESSIONS_BY_UUID_PREFIX = `
  SELECT s.id, s.session_uuid, s.file_tier, s.file_path, p.cwd, p.dir_name
  FROM sessions s JOIN projects p ON p.id = s.project_id
  WHERE s.session_uuid LIKE ?
  ORDER BY CASE s.file_tier WHEN 'session' THEN 0 WHEN 'subagent' THEN 1 ELSE 2 END, s.id
`;
