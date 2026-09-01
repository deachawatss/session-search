// status.ts — what the index holds, and HOW STALE it is.
//
// The staleness half is not decoration. v2 cannot refresh the index it reads, so a v2
// that reported only counts would silently serve stale data — recreating, one layer up,
// the exact bug this app was built to surface (`search_sessions("session-search")` →
// 0 hits while that very session was being written). A reader that cannot fix staleness
// must at minimum name it.

import type { Db } from "./db";
import type {
  CountRow,
  DateRangeRow,
  ImportRunRow,
  IndexStatus,
  LastImport,
  StatusCountRow,
  TierCountRow,
} from "./types";
import {
  COUNT_SESSIONS,
  COUNT_SESSIONS_BY_STATUS,
  COUNT_SESSIONS_BY_TIER,
  LAST_IMPORT_RUN,
  SESSION_DATE_RANGE,
} from "./sql";

function lastImport(db: Db, now: number): LastImport | null {
  const r = db.handle.query<ImportRunRow, []>(LAST_IMPORT_RUN).get();
  if (!r) return null;
  // SQLite's datetime('now') writes UTC without a zone marker; parse it as UTC explicitly
  // rather than letting Date.parse guess local time, which would skew age by the offset.
  const finishedMs = r.finished_at ? Date.parse(`${r.finished_at.replace(" ", "T")}Z`) : NaN;
  return {
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    filesScanned: r.files_scanned,
    filesNew: r.files_new,
    filesChanged: r.files_changed,
    ageSeconds: Number.isNaN(finishedMs) ? null : Math.max(0, now - finishedMs / 1000),
  };
}

export function indexStatus(db: Db, now: number = Date.now() / 1000): IndexStatus {
  const total = db.handle.query<CountRow, []>(COUNT_SESSIONS).get();

  const byTier: Record<string, number> = {};
  for (const r of db.handle.query<TierCountRow, []>(COUNT_SESSIONS_BY_TIER).all()) {
    byTier[r.file_tier] = r.n;
  }

  const byStatus: Record<string, number> = {};
  for (const r of db.handle.query<StatusCountRow, []>(COUNT_SESSIONS_BY_STATUS).all()) {
    byStatus[r.import_status] = r.n;
  }

  const range = db.handle.query<DateRangeRow, []>(SESSION_DATE_RANGE).get();

  return {
    totalSessions: total?.n ?? 0,
    byTier,
    byStatus,
    earliestStartedAt: range?.minTs ?? null,
    latestStartedAt: range?.maxTs ?? null,
    lastImport: lastImport(db, now),
  };
}

export function humanAge(seconds: number | null): string {
  if (seconds === null) return "unknown";
  if (seconds < 60) return `${Math.round(seconds)}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/// The one-line honesty note. Shown by `status`, and by `search` when it finds nothing —
/// "no matches" and "no matches YET because the index is 3 days old" are different answers.
export function stalenessNote(s: IndexStatus): string {
  if (!s.lastImport) return "⚠ index staleness unknown — no import_runs row found";
  if (s.lastImport.ageSeconds === null) {
    return "⚠ last import never finished — the index may be incomplete";
  }
  const age = humanAge(s.lastImport.ageSeconds);
  const stale = s.lastImport.ageSeconds > 86_400;
  return `${stale ? "⚠" : "·"} index last imported ${age}` +
    (stale ? "  — run `session-viewer import` to refresh" : "");
}
