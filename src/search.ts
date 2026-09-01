// search.ts — query construction + execution. Ported from session-viewer's Store.swift
// `ftsQuery`/`trigramQuery`/`usesTrigram`/`searchEvents`/`searchEventsFiltered`.
//
// The SQL itself lives in sql.ts; this file owns query-text transformation, fixed-fragment
// selection, and execution.

import type { Db } from "./db";
import { TRIGRAM_MIN_CHARS, DEFAULT_SEARCH_LIMIT } from "./const";
import type { SearchFilters, SearchHit, SearchParams, SearchRow } from "./types";
import {
  SEARCH_EVENTS,
  SEARCH_EVENTS_BASE,
  SEARCH_EVENTS_ORDER,
  SEARCH_EVENTS_TRI,
  SEARCH_EVENTS_TRI_BASE,
  SEARCH_EVENTS_TRI_ORDER,
  SEARCH_PROJECT_FILTER,
  SEARCH_SINCE_FILTER,
  SEARCH_SOURCE_FILTER,
  SEARCH_TIER_FILTER,
  SEARCH_UNTIL_FILTER,
} from "./sql";

/// Which index answers a query. Trigram wherever it can (measured 100% recall on both Thai
/// and English against 1-97% for unicode61); unicode61 for needles too short for a trigram
/// to exist. Not a hedge — each index is genuinely unable to serve the other's case.
export function usesTrigram(query: string): boolean {
  return query.trim().length >= TRIGRAM_MIN_CHARS;
}

function quoteToken(raw: string): string {
  return `"${raw.replaceAll('"', '""')}"`;
}

/// FTS5 query text for the unicode61 index.
///
/// Every token is quoted so `-`, `.`, `/` and friends are data rather than FTS5 operators.
/// This is the `append-only` bug's tombstone: an unquoted hyphen parsed as NOT, failed at
/// step, and the row loop read the error as "no rows" — so search silently returned nothing.
///
/// The trailing `*` makes token matching find `9cda6f37` from `9c`.
export function ftsQuery(raw: string): string {
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  const quoted = tokens.map(quoteToken);
  const last = quoted[quoted.length - 1];
  return [...quoted.slice(0, -1), `${last}*`].join(" ");
}

/// Same quoting discipline, and the ONE deliberate difference: no trailing `*`. Trigram
/// already matches substrings natively; adding the wildcard matches any document containing
/// a trigram with that prefix — measured `"work"*` = 4527 rows against a truth of 771.
/// It would trade a recall problem for a precision problem.
export function trigramQuery(raw: string): string {
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return '""';
  return tokens.map(quoteToken).join(" ");
}

export function searchEvents(db: Db, query: string, limit = DEFAULT_SEARCH_LIMIT): SearchHit[] {
  const trigram = usesTrigram(query);
  const q = trigram ? trigramQuery(query) : ftsQuery(query);
  const rows = db.handle
    .query<SearchRow, SearchParams>(trigram ? SEARCH_EVENTS_TRI : SEARCH_EVENTS)
    .all(q, limit);

  return rowsToHits(rows);
}

export function searchEventsFiltered(
  db: Db,
  query: string,
  filters: SearchFilters,
  limit = DEFAULT_SEARCH_LIMIT
): SearchHit[] {
  const trigram = usesTrigram(query);
  let sql = trigram ? SEARCH_EVENTS_TRI_BASE : SEARCH_EVENTS_BASE;

  // Fragments are fixed literals selected only by whether a filter was passed. Caller
  // input is never SQL text; all values are appended to params and bound below.
  if (filters.project !== undefined) sql += SEARCH_PROJECT_FILTER;
  if (filters.tier !== undefined) sql += SEARCH_TIER_FILTER;
  if (filters.source !== undefined) sql += SEARCH_SOURCE_FILTER;
  if (filters.since !== undefined) sql += SEARCH_SINCE_FILTER;
  if (filters.until !== undefined) sql += SEARCH_UNTIL_FILTER;
  sql += trigram ? SEARCH_EVENTS_TRI_ORDER : SEARCH_EVENTS_ORDER;

  const q = trigram ? trigramQuery(query) : ftsQuery(query);
  const params: Array<string | number> = [q];
  if (filters.project !== undefined) {
    const project = `%${filters.project}%`;
    params.push(project, project);
  }
  if (filters.tier !== undefined) params.push(filters.tier);
  if (filters.source !== undefined) params.push(filters.source);
  // started_at is stored as ISO-8601 text. Bind the caller's ISO bounds verbatim, like the
  // reference implementation; parsing/reformatting here could silently change offsets.
  if (filters.since !== undefined) params.push(filters.since);
  if (filters.until !== undefined) params.push(filters.until);
  params.push(limit);

  const rows = db.handle.query<SearchRow, Array<string | number>>(sql).all(...params);
  // With no filters the projection, ranking, limit, and dedupe are identical to searchEvents.
  return rowsToHits(rows);
}

function rowsToHits(rows: SearchRow[]): SearchHit[] {
  // Dedupe. The same text can be indexed more than once for one session — observed live:
  // searching `ระจก` returned the identical [600de3a0] user line twice, same seq. Keying on
  // (session, seq) collapses those without hiding genuinely distinct hits that merely share
  // a snippet.
  const seen = new Set<string>();
  const hits: SearchHit[] = [];
  for (const r of rows) {
    const key = `${r.session_id}:${r.seq}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      sessionId: r.session_id,
      uuid: r.session_uuid,
      role: r.role,
      ts: r.ts,
      seq: r.seq,
      snippet: r.snippet,
      score: r.score,
    });
  }
  return hits;
}
