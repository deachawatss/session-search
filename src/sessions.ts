// sessions.ts — horizon-bucketed session listing. This is session-search's reason to
// exist: session-viewer indexes and searches, but has no concept of memory horizons.

import type { Db } from "./db";
import { horizonBounds, horizonLabel, horizonOf } from "./horizon";
import { COUNT_SESSIONS_IN_WINDOW, SESSIONS_IN_WINDOW } from "./sql";
import type {
  CountRow,
  HorizonBucket,
  HorizonListing,
  SessionRow,
  SessionSummary,
  WindowCountParams,
  WindowParams,
} from "./types";

/// The project's real path comes from the importer's recorded `cwd`, never from decoding
/// the directory name — that encoding maps both `/` and `.` to `-`, so it is lossy and
/// ambiguous in both directions. `dir_name` is the display-only fallback.
function projectName(row: SessionRow): string | null {
  if (row.cwd) return row.cwd.split("/").slice(-2).join("/");
  return row.dir_name;
}

function toSummary(row: SessionRow, now: number): SessionSummary {
  const epoch = row.started_at ? Date.parse(row.started_at) / 1000 : NaN;
  return {
    id: row.id,
    uuid: row.session_uuid,
    tier: row.file_tier,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    eventCount: row.event_count,
    description: row.description,
    project: projectName(row),
    horizon: Number.isNaN(epoch) ? "archive" : horizonOf(epoch, now),
  };
}

export function listByHorizon(
  db: Db,
  bucket: HorizonBucket,
  limit = 20,
  now: number = Date.now() / 1000
): HorizonListing {
  const { min, max } = horizonBounds(bucket, now);
  // BETWEEN takes integers; the sentinels are ±2^60 and would overflow SQLite's INTEGER
  // as floats, so clamp to a range that safely covers any real timestamp.
  const lo = Math.max(Math.floor(min), -62_135_596_800);
  const hi = Math.min(Math.floor(max), 253_402_300_799);

  const total =
    db.handle.query<CountRow, WindowCountParams>(COUNT_SESSIONS_IN_WINDOW).get(lo, hi)?.n ?? 0;
  const rows = db.handle
    .query<SessionRow, WindowParams>(SESSIONS_IN_WINDOW)
    .all(lo, hi, limit);

  return {
    bucket,
    label: horizonLabel(bucket),
    total,
    shown: rows.length,
    sessions: rows.map((r) => toSummary(r, now)),
  };
}

/// Counts for every bucket — the "where does my history actually sit" view.
export function horizonOverview(
  db: Db,
  now: number = Date.now() / 1000
): Array<{ bucket: HorizonBucket; label: string; total: number }> {
  const out: Array<{ bucket: HorizonBucket; label: string; total: number }> = [];
  for (const bucket of ["short", "mid", "long", "archive"] as const) {
    const { min, max } = horizonBounds(bucket, now);
    const lo = Math.max(Math.floor(min), -62_135_596_800);
    const hi = Math.min(Math.floor(max), 253_402_300_799);
    const total =
      db.handle.query<CountRow, WindowCountParams>(COUNT_SESSIONS_IN_WINDOW).get(lo, hi)?.n ?? 0;
    out.push({ bucket, label: horizonLabel(bucket), total });
  }
  return out;
}
