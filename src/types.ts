// types.ts — the shared shapes, in one place.
//
// Hand-written because this app has no ORM to generate them (see SPEC.md). That is the
// tradeoff paid on purpose: raw SQL keeps the schema reviewable, and the cost is that
// these must be kept in step by hand — with the extra wrinkle that v2 does not OWN the
// schema it reads. A session-viewer migration can invalidate these with no compile-time
// signal, which is the standing risk of the read-only design.

// MARK: - search

export interface SearchHit {
  sessionId: number;
  uuid: string;
  role: string;
  ts: string | null;
  /// Line number within the transcript, 1-based over NON-EMPTY lines. This is what makes a
  /// hit navigable — pass it to read_context.
  seq: number;
  snippet: string;
  score: number;
}

export interface SearchFilters {
  project?: string;
  tier?: string;
  source?: string;
  since?: string;
  until?: string;
}

// MARK: - status

export interface IndexStatus {
  totalSessions: number;
  byTier: Record<string, number>;
  byStatus: Record<string, number>;
  earliestStartedAt: string | null;
  latestStartedAt: string | null;
  lastImport: LastImport | null;
}

export interface LastImport {
  startedAt: string | null;
  finishedAt: string | null;
  filesScanned: number | null;
  filesNew: number | null;
  filesChanged: number | null;
  /// Seconds since the run finished; null if it never finished (an interrupted import).
  ageSeconds: number | null;
}

// MARK: - horizons

export type HorizonBucket = "short" | "mid" | "long" | "archive";

export interface HorizonRange {
  min: number;
  max: number;
}

export interface SessionSummary {
  id: number;
  uuid: string;
  tier: string;
  startedAt: string | null;
  endedAt: string | null;
  eventCount: number | null;
  description: string | null;
  project: string | null;
  horizon: HorizonBucket;
}

export interface HorizonListing {
  bucket: HorizonBucket;
  label: string;
  total: number;
  shown: number;
  sessions: SessionSummary[];
}

// MARK: - statement shapes
//
// Bind-parameter tuples and raw row projections for the statements in sql.ts. Named after
// their statement, so the pairing stays obvious. A tuple that stops matching its statement
// is a compile error at the call site, which is the whole point.

export type SearchParams = [query: string, limit: number];

export interface SearchRow {
  session_id: number;
  session_uuid: string;
  role: string;
  ts: string | null;
  seq: number;
  snippet: string;
  score: number;
}

export interface CountRow {
  n: number;
}

export interface TierCountRow {
  file_tier: string;
  n: number;
}

export interface StatusCountRow {
  import_status: string;
  n: number;
}

export interface DateRangeRow {
  minTs: string | null;
  maxTs: string | null;
}

export interface ImportRunRow {
  started_at: string | null;
  finished_at: string | null;
  files_scanned: number | null;
  files_new: number | null;
  files_changed: number | null;
}

export type WindowParams = [min: number, max: number, limit: number];
export type WindowCountParams = [min: number, max: number];

export interface SessionRow {
  id: number;
  session_uuid: string;
  file_tier: string;
  started_at: string | null;
  ended_at: string | null;
  event_count: number | null;
  description: string | null;
  cwd: string | null;
  dir_name: string | null;
}

// MARK: - transcript reading

export interface SessionLocatorRow {
  id: number;
  session_uuid: string;
  file_tier: string;
  file_path: string;
  cwd: string | null;
  dir_name: string | null;
}

export interface TranscriptLine {
  seq: number;
  type: string;
  ts: string | null;
  text: string;
}

export interface ContextLine extends TranscriptLine {
  isHit: boolean;
}

export interface ContextResult {
  sessionId: number;
  uuid: string;
  tier: string;
  filePath: string;
  project: string | null;
  hitSeq: number;
  from: number;
  to: number;
  /// How many OTHER transcripts shared the uuid prefix the caller gave. Non-zero means the
  /// answer was disambiguated for them, and they should know.
  ambiguous: number;
  lines: ContextLine[];
}

export interface ReadSessionResult {
  sessionId: number;
  uuid: string;
  tier: string;
  filePath: string;
  project: string | null;
  /// Requested first seq. Seq is 1-based over non-empty source lines, exactly as in search
  /// hits and read_context.
  from: number;
  limit: number;
  /// Last seq returned, or null when `from` is past the end.
  to: number | null;
  /// How many OTHER transcripts shared the uuid prefix the caller gave.
  ambiguous: number;
  /// True only when the reader observed source EOF rather than stopping on a lookahead
  /// line. This makes an exactly-full final page distinguishable from "more available".
  reachedEnd: boolean;
  nextFrom: number | null;
  /// Total non-empty source lines, known only after EOF was observed.
  endSeq: number | null;
  lines: TranscriptLine[];
}
