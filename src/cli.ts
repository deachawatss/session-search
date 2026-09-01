#!/usr/bin/env bun
// cli.ts — verb dispatch, ported from session-viewer's CommandRegistry pattern: one
// declared table drives dispatch AND the MCP tool schemas, instead of a switch statement
// that can silently drift from what --help prints.

import { Db } from "./db";
import { DEFAULT_DB, DEFAULT_SEARCH_LIMIT, SEARCH_SOURCES, SEARCH_TIERS } from "./const";
import { HORIZON_BUCKETS, horizonSelfTest, isHorizonBucket } from "./horizon";
import { horizonOverview, listByHorizon } from "./sessions";
import { humanAge, indexStatus, stalenessNote } from "./status";
import { searchEventsFiltered } from "./search";
import { readContext, readSession } from "./context";
import { getVersionDetail } from "./version";

function flag(args: string[], name: string, fallback: string): string {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return fallback;
  return args[i + 1] as string;
}

function optionalFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1] as string;
}

function openDb(args: string[]): Db {
  return new Db(flag(args, "db", DEFAULT_DB));
}

interface Verb {
  name: string;
  summary: string;
  run(args: string[]): void;
}

const VERBS: Verb[] = [
  {
    name: "version",
    summary: "build stamp — v{yy}.{m}.{d}-{HMM} of the last commit that touched this app",
    run() {
      const { version, commit, subject } = getVersionDetail();
      console.log(version);
      if (commit) console.log(`  ${commit}  ${subject}`);
    },
  },
  {
    name: "horizons",
    summary: "how your session history sits across short/mid/long/archive",
    run(args) {
      const db = openDb(args);
      const rows = horizonOverview(db);
      const status = indexStatus(db);
      db.close();
      const total = rows.reduce((a, r) => a + r.total, 0) || 1;
      for (const r of rows) {
        const pct = (100 * r.total) / total;
        const bar = "█".repeat(Math.round(pct / 2));
        console.log(
          `${r.bucket.padEnd(8)} ${r.label.padEnd(9)} ${String(r.total).padStart(6)}  ` +
            `${pct.toFixed(1).padStart(5)}%  ${bar}`
        );
      }
      console.log(`\n${stalenessNote(status)}`);
    },
  },
  {
    name: "list",
    summary: "sessions in one horizon — list --horizon short|mid|long|archive [--limit n]",
    run(args) {
      const bucket = flag(args, "horizon", "short");
      if (!isHorizonBucket(bucket)) {
        console.error(`unknown horizon: ${bucket}\nvalid: ${HORIZON_BUCKETS.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const limit = Number(flag(args, "limit", "20"));
      const db = openDb(args);
      const listing = listByHorizon(db, bucket, limit);
      const status = indexStatus(db);
      db.close();
      console.log(
        `${listing.bucket} (${listing.label}) — ${listing.total} sessions, showing ${listing.shown}\n`
      );
      for (const s of listing.sessions) {
        const when = s.startedAt?.slice(0, 16).replace("T", " ") ?? "—";
        const proj = (s.project ?? "—").slice(-32);
        const desc = (s.description ?? "").replace(/\s+/g, " ").slice(0, 60);
        console.log(
          `${when}  ${String(s.eventCount ?? 0).padStart(5)}ev  ${proj.padEnd(32)}  ${desc}`
        );
      }
      console.log(`\n${stalenessNote(status)}`);
    },
  },
  {
    name: "search",
    summary:
      "full-text search — search <query> [--project text] [--tier tier] [--source source] [--since ISO] [--until ISO]",
    run(args) {
      const query = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1]?.startsWith("--") !== true);
      const positional = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
      const q = positional[0] ?? query;
      if (!q) {
        console.error(
          "usage: search <query> [--project text] [--tier session|subagent|workflow_agent] " +
            "[--source claude|codex] [--since ISO-8601] [--until ISO-8601] [--limit n] [--db path]"
        );
        process.exitCode = 1;
        return;
      }
      const tier = optionalFlag(args, "tier");
      if (tier !== undefined && !SEARCH_TIERS.includes(tier as (typeof SEARCH_TIERS)[number])) {
        console.error(`unknown tier: ${tier}\nvalid: ${SEARCH_TIERS.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const source = optionalFlag(args, "source");
      if (
        source !== undefined &&
        !SEARCH_SOURCES.includes(source as (typeof SEARCH_SOURCES)[number])
      ) {
        console.error(`unknown source: ${source}\nvalid: ${SEARCH_SOURCES.join(", ")}`);
        process.exitCode = 1;
        return;
      }
      const limit = Number(flag(args, "limit", String(DEFAULT_SEARCH_LIMIT)));
      const db = openDb(args);
      const hits = searchEventsFiltered(
        db,
        q,
        {
          project: optionalFlag(args, "project"),
          tier,
          source,
          since: optionalFlag(args, "since"),
          until: optionalFlag(args, "until"),
        },
        limit
      );
      const status = indexStatus(db);
      db.close();
      if (hits.length === 0) {
        // "no matches" and "no matches YET, the index is 3 days old" are different answers.
        console.log("No matches");
        console.log(stalenessNote(status));
        return;
      }
      for (const h of hits) {
        // session id + seq are printed because they are the ARGUMENTS to `context` —
        // a hit you cannot navigate to is only half an answer.
        console.log(
          `#${String(h.sessionId).padStart(5)}:${String(h.seq).padEnd(6)} ${h.role.padEnd(9)} ` +
            `${h.ts?.slice(0, 16).replace("T", " ") ?? "—"}  ${h.snippet}`
        );
      }
      console.log(
        `\n${hits.length} hits — ${stalenessNote(status).replace(/^[·⚠]\s*/, "")}\n` +
          `see context:  cli.ts context <id> <seq>   e.g. context ${hits[0]!.sessionId} ${hits[0]!.seq}`
      );
    },
  },
  {
    name: "context",
    summary: "messages around a hit — context <session-id|uuid-prefix> <seq> [--before n] [--after n]",
    run(args) {
      const pos = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
      const locator = pos[0];
      const seq = Number(pos[1]);
      if (!locator || !Number.isFinite(seq)) {
        console.error("usage: context <session-id|uuid-prefix> <seq> [--before n] [--after n]");
        console.error("  ids and seqs come from `search` output, printed as #id:seq");
        process.exitCode = 1;
        return;
      }
      const before = Number(flag(args, "before", "4"));
      const after = Number(flag(args, "after", "6"));
      const db = openDb(args);
      readContext(db, locator, seq, before, after)
        .then((ctx) => {
          console.log(`session #${ctx.sessionId} ${ctx.uuid.slice(0, 8)} (${ctx.tier})  ${ctx.project ?? "—"}`);
          if (ctx.ambiguous > 0) {
            console.log(
              `note: uuid prefix matched ${ctx.ambiguous} other transcript(s) (subagents share the uuid); showing the ${ctx.tier} tier`
            );
          }
          console.log(`lines ${ctx.from}-${ctx.to}, hit at ${ctx.hitSeq}\n`);
          for (const l of ctx.lines) {
            const mark = l.isHit ? "▶" : " ";
            const when = l.ts?.slice(11, 16) ?? "  —  ";
            const text = l.text.replace(/\s+/g, " ").slice(0, 140);
            console.log(`${mark} ${String(l.seq).padStart(6)}  ${l.type.padEnd(10)} ${when}  ${text}`);
          }
          db.close();
        })
        .catch((e) => {
          db.close();
          console.error(e instanceof Error ? e.message : String(e));
          process.exitCode = 1;
        });
    },
  },
  {
    name: "session",
    summary: "page a transcript in order — session <session-id|uuid-prefix> [--from n] [--limit n]",
    run(args) {
      const pos = args.filter((a, i) => !a.startsWith("--") && !args[i - 1]?.startsWith("--"));
      const locator = pos[0];
      if (!locator) {
        console.error("usage: session <session-id|uuid-prefix> [--from n] [--limit n]");
        process.exitCode = 1;
        return;
      }
      const from = Number(flag(args, "from", "1"));
      const limit = Number(flag(args, "limit", "30"));
      const db = openDb(args);
      const status = indexStatus(db);
      readSession(db, locator, from, limit)
        .then((page) => {
          console.log(
            `session #${page.sessionId} ${page.uuid.slice(0, 8)} (${page.tier})  ${page.project ?? "—"}`
          );
          if (page.ambiguous > 0) {
            console.log(
              `note: uuid prefix matched ${page.ambiguous} other transcript(s) (subagents share the uuid); showing the ${page.tier} tier`
            );
          }
          if (page.lines.length === 0) {
            console.log(`no lines at or after seq ${page.from}`);
          } else {
            console.log(`lines ${page.lines[0]!.seq}-${page.to} (${page.lines.length})\n`);
            for (const l of page.lines) {
              const when = l.ts?.slice(11, 16) ?? "  —  ";
              const text = l.text.replace(/\s+/g, " ").slice(0, 140);
              console.log(`  ${String(l.seq).padStart(6)}  ${l.type.padEnd(10)} ${when}  ${text}`);
            }
          }
          if (page.reachedEnd) {
            console.log(`\nreached end at seq ${page.endSeq ?? 0}`);
          } else {
            console.log(
              `\nmore: session ${page.sessionId} --from ${page.nextFrom} --limit ${page.limit}`
            );
          }
          console.log(`\n${stalenessNote(status)}`);
          db.close();
        })
        .catch((e) => {
          db.close();
          console.error(e instanceof Error ? e.message : String(e));
          process.exitCode = 1;
        });
    },
  },
  {
    name: "status",
    summary: "what the index holds, and how stale it is",
    run(args) {
      const db = openDb(args);
      const s = indexStatus(db);
      const path = db.path;
      db.close();
      console.log(`session-search ${getVersionDetail().version}`);
      console.log(`index      ${path}  (read-only)`);
      console.log(`sessions   ${s.totalSessions}`);
      console.log(`by tier    ${JSON.stringify(s.byTier)}`);
      console.log(`by status  ${JSON.stringify(s.byStatus)}`);
      console.log(`range      ${s.earliestStartedAt ?? "—"} .. ${s.latestStartedAt ?? "—"}`);
      if (s.lastImport) {
        console.log(
          `last import ${s.lastImport.finishedAt ?? "(never finished)"} ` +
            `(${humanAge(s.lastImport.ageSeconds)}) — scanned ${s.lastImport.filesScanned ?? "?"}, ` +
            `new ${s.lastImport.filesNew ?? "?"}, changed ${s.lastImport.filesChanged ?? "?"}`
        );
      }
      console.log(`\n${stalenessNote(s)}`);
    },
  },
  {
    name: "selftest",
    summary: "verify horizonOf and horizonBounds agree at every boundary",
    run() {
      const { passed, failures } = horizonSelfTest();
      if (failures.length === 0) {
        console.log(`✓ horizon partition: ${passed} assertions passed`);
      } else {
        console.log(`✗ horizon partition: ${failures.length} FAILURES (${passed} passed)`);
        for (const f of failures.slice(0, 20)) console.log(`  ${f}`);
        process.exitCode = 1;
      }
    },
  },
  {
    name: "mcp",
    summary: "MCP server on stdio (a client normally launches this, not you)",
    run(args) {
      // Imported lazily: the MCP server takes over stdio, so nothing else must write to it.
      import("./mcp").then((m) => m.runMCPServer(flag(args, "db", DEFAULT_DB)));
    },
  },
];

function printHelp(): void {
  const width = Math.max(...VERBS.map((v) => v.name.length));
  console.log("session-search — horizon-aware search over session-viewer's index\n");
  console.log("usage: cli.ts <verb> [flags]\n");
  for (const v of VERBS) console.log(`  ${v.name.padEnd(width + 2)}${v.summary}`);
  console.log(`\nhorizons: ${HORIZON_BUCKETS.join(" · ")}`);
  console.log(
    "flags:    --db <path>  --limit <n>  --horizon <bucket>  --project <text>  " +
      "--tier <tier>  --since <ISO>  --until <ISO>  --from <seq>"
  );
}

const [, , verbName, ...rest] = process.argv;
const verb = VERBS.find((v) => v.name === verbName);
if (!verb) {
  printHelp();
  process.exitCode = verbName ? 1 : 0;
} else {
  try {
    verb.run(rest);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}
