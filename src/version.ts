// version.ts — a build stamp, same scheme as this fleet's /calver:
//
//   v{yy}.{m}.{d}-{HMM}     HMM = H*100+M, no leading zero, one slot per minute
//
// session-search has no release process to version against — no tags, no package
// bump — so unlike arra-oracle-skills-cli's calver.ts (which walks git tags AND
// package.json as competing sources of truth), there is exactly one honest source
// here: the timestamp of the last commit that actually touched this app. That is a
// real "when was this built" stamp, not a decoration — it is also the direct answer
// to whether an MCP client's stale registration is running old code.
//
// Deliberately NOT wall-clock-at-invocation — a "version" that changes every minute
// the tool merely RUNS would not be a version, it would be a clock.

import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // .../session-search

/// Bangkok time, matching /calver's fixed TZ — a version must not depend on the
/// machine's local zone, or the same commit would stamp differently on different hosts.
export function getVersion(): string {
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%ad", "--date=format-local:%y.%-m.%-d.%H.%-M", "--", APP_DIR],
      { cwd: APP_DIR, encoding: "utf-8", env: { ...process.env, TZ: "Asia/Bangkok" } }
    ).trim();
    if (!out) return "v0.0.0-unreleased"; // uncommitted — no history to stamp from
    const [yy, m, d, h, min] = out.split(".");
    const hmm = String(Number(h) * 100 + Number(min));
    return `v${yy}.${m}.${d}-${hmm}`;
  } catch {
    // git unavailable or app dir not in a repo — degrade to a marker, never throw.
    // A version check must never be the thing that breaks the tool it's checking.
    return "v0.0.0-unknown";
  }
}

/// The commit that produced this version, for `version --verbose` / status.
export function getVersionDetail(): { version: string; commit: string | null; subject: string | null } {
  const version = getVersion();
  try {
    const out = execFileSync(
      "git",
      ["log", "-1", "--format=%h%x09%s", "--", APP_DIR],
      { cwd: APP_DIR, encoding: "utf-8" }
    ).trim();
    const [commit, subject] = out.split("\t");
    return { version, commit: commit ?? null, subject: subject ?? null };
  } catch {
    return { version, commit: null, subject: null };
  }
}
