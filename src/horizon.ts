// horizon.ts — memory horizons over sessions. Ported from LISTEN's Core.swift
// `Horizon.of`/`Horizon.bounds`, with cut-points recalibrated for this corpus (see
// const.ts CUT_DAYS for the measurement that set them).
//
// Both functions derive from const.ts's CUT_DAYS. That sharing is not stylistic: LISTEN's
// first build had these as two independently-written formulas, and they disagreed at exact
// day-boundaries and on future dates (a file exactly 7.0 days old counted in two buckets;
// future-dated rows fell out of all four). The adversarial panel caught it within the hour.
// One table means there is only one number to edit, so they cannot drift.
//
// Computed at READ time, never stored — a stored horizon goes stale daily.

import { CUT_DAYS, FAR, SECONDS_PER_DAY } from "./const";
import type { HorizonBucket, HorizonRange } from "./types";

export const HORIZON_BUCKETS: readonly HorizonBucket[] = [
  "short",
  "mid",
  "long",
  "archive",
] as const;

export function isHorizonBucket(s: string): s is HorizonBucket {
  return (HORIZON_BUCKETS as readonly string[]).includes(s);
}

/// Human-readable range for a bucket. Exists because the bucket NAMES are relative
/// (`mid` does not tell you it means 30-60 days) — that legibility gap is paid here and
/// in every user-facing description, rather than by renaming the buckets and diverging
/// from LISTEN's vocabulary.
export function horizonLabel(bucket: HorizonBucket): string {
  switch (bucket) {
    case "short":
      return `≤${CUT_DAYS.short}d`;
    case "mid":
      return `${CUT_DAYS.short}-${CUT_DAYS.mid}d`;
    case "long":
      return `${CUT_DAYS.mid}-${CUT_DAYS.long}d`;
    case "archive":
      return `>${CUT_DAYS.long}d`;
  }
}

export function horizonOf(writtenAt: number, now: number = Date.now() / 1000): HorizonBucket {
  const days = (now - writtenAt) / SECONDS_PER_DAY;
  if (days <= CUT_DAYS.short) return "short";
  if (days <= CUT_DAYS.mid) return "mid";
  if (days <= CUT_DAYS.long) return "long";
  return "archive";
}

/// Epoch-second cutoffs for a bucket, as INCLUSIVE (min, max) bounds for BETWEEN.
///
/// `horizonOf` tests `days <= N`, so a row at exactly `now - N days` is still in that
/// bucket — each bucket's min is its own cut, and the next-older bucket's max is cut-1.
/// (LISTEN's first derivation put the +1 on the wrong side; a partition test caught it.)
export function horizonBounds(
  bucket: HorizonBucket,
  now: number = Date.now() / 1000
): HorizonRange {
  const n = Math.floor(now);
  const cutShort = n - CUT_DAYS.short * SECONDS_PER_DAY;
  const cutMid = n - CUT_DAYS.mid * SECONDS_PER_DAY;
  const cutLong = n - CUT_DAYS.long * SECONDS_PER_DAY;
  switch (bucket) {
    case "short":
      return { min: cutShort, max: FAR }; // INCLUDING future-dated rows
    case "mid":
      return { min: cutMid, max: cutShort - 1 };
    case "long":
      return { min: cutLong, max: cutMid - 1 };
    case "archive":
      return { min: -FAR, max: cutLong - 1 };
  }
}

/// Self-test: the two functions must agree at every boundary, and the four buckets must
/// TOTALLY partition the timeline (no epoch in two buckets, none in zero). This is the
/// drift-lock for the defect LISTEN actually shipped once.
export function horizonSelfTest(now = 1_800_000_000): { passed: number; failures: string[] } {
  const failures: string[] = [];
  let passed = 0;

  // Every bucket's own bounds must classify back to that bucket, at both edges.
  for (const b of HORIZON_BUCKETS) {
    const { min, max } = horizonBounds(b, now);
    for (const [edge, v] of [["min", min], ["max", max]] as const) {
      // Skip the infinite sentinels — they are unbounded by construction.
      if (Math.abs(v) >= FAR) continue;
      const got = horizonOf(v, now);
      if (got === b) passed++;
      else failures.push(`bounds(${b}).${edge}=${v} classifies as ${got}, expected ${b}`);
    }
  }

  // Totality + exclusivity across a dense sweep, including future and pre-epoch.
  for (let d = -5; d <= 400; d += 0.5) {
    const t = now - d * SECONDS_PER_DAY;
    const hit = HORIZON_BUCKETS.filter((b) => {
      const { min, max } = horizonBounds(b, now);
      return t >= min && t <= max;
    });
    if (hit.length === 1 && hit[0] === horizonOf(t, now)) passed++;
    else failures.push(`age ${d}d: bounds match [${hit.join(",")}], of() says ${horizonOf(t, now)}`);
  }

  return { passed, failures };
}
