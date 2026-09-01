// mcp.ts — MCP server on stdio.
//
// Protocol version is NEGOTIATED, never hardcoded. Both LISTEN twins shipped broken
// because they always replied their own modern constant ("2026-07-28") while the real
// client (Claude Code 2.1.247) asks for "2025-11-25" — the server was rejected with
// "protocol version is not supported" and looked like a connection bug. The negotiate-or-
// fall-back-to-handshake-default logic below is ported from session-viewer's MCP.swift,
// which had already solved it. This is the third implementation of that fix in this fleet;
// it exists here from the start so there is no fourth.

import { Db } from "./db";
import { HORIZON_BUCKETS, horizonLabel, isHorizonBucket } from "./horizon";
import { horizonOverview, listByHorizon } from "./sessions";
import { humanAge, indexStatus, stalenessNote } from "./status";
import { searchEventsFiltered } from "./search";
import { readContext, readSession } from "./context";
import { DEFAULT_SEARCH_LIMIT, SEARCH_SOURCES, SEARCH_TIERS } from "./const";
import { getVersion } from "./version";

const MCP_MODERN_VERSIONS = ["2026-07-28"];
const MCP_HANDSHAKE_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_SUPPORTED_VERSIONS = [...MCP_MODERN_VERSIONS, ...MCP_HANDSHAKE_VERSIONS];

const SERVER_INFO = { name: "session-search", version: getVersion() };

const INSTRUCTIONS =
  "Horizon-aware view over session-viewer's index (read-only — this server never writes). " +
  "Sessions are bucketed by age into short/mid/long/archive, computed at query time. " +
  "Use list_by_horizon to answer 'what was I working on recently/back then', horizons for " +
  "the shape of the whole history, and search_sessions for words in the text (FTS5 trigram, " +
  "the only index that finds Thai inside words). Use read_session to page a transcript in order. " +
  "Every response reports index staleness — " +
  "this server cannot refresh the index, so 'no matches' may mean 'not imported yet'.";

interface Tool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const HORIZON_ENUM_DOC = HORIZON_BUCKETS.map((b) => `${b} (${horizonLabel(b)})`).join(", ");

const TOOLS: Tool[] = [
  {
    name: "horizons",
    title: "Shape of your session history",
    description:
      "Counts of indexed sessions in each age bucket. Answers 'how far back does my history go and where is it concentrated'. " +
      `Buckets: ${HORIZON_ENUM_DOC}.`,
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "list_by_horizon",
    title: "Sessions in one age bucket",
    description:
      "Sessions whose start time falls in one age bucket, newest first, with project and first-message description. " +
      `Buckets: ${HORIZON_ENUM_DOC}. Bucketing is by session START, not last write.`,
    inputSchema: {
      type: "object",
      properties: {
        horizon: {
          type: "string",
          enum: [...HORIZON_BUCKETS],
          description: `Which bucket. ${HORIZON_ENUM_DOC}.`,
        },
        limit: { type: "integer", description: "Max sessions (default 20).", default: 20 },
      },
      required: ["horizon"],
      additionalProperties: false,
    },
  },
  {
    name: "search_sessions",
    title: "Search session transcripts",
    description:
      "Full-text search over conversational content. Uses FTS5 trigram for queries of 3+ characters — " +
      "the only index here that matches Thai inside words — and a prefix-token index for shorter needles. " +
      "Returns a snippet with «» around matches.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Text to search for. English or Thai." },
        project: {
          type: "string",
          description: "Project substring matched against both its real cwd and encoded directory name.",
        },
        tier: {
          type: "string",
          enum: [...SEARCH_TIERS],
          description: `Exact transcript tier. ${SEARCH_TIERS.join(", ")}.`,
        },
        source: {
          type: "string",
          enum: [...SEARCH_SOURCES],
          description: `Exact session source. ${SEARCH_SOURCES.join(", ")}.`,
        },
        since: {
          type: "string",
          description: "Only sessions started at or after this ISO-8601 timestamp (inclusive).",
        },
        until: {
          type: "string",
          description: "Only sessions started at or before this ISO-8601 timestamp (inclusive).",
        },
        limit: { type: "integer", description: "Max results (default 20).", default: 20 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_context",
    title: "Messages around a search hit",
    description:
      "The conversation surrounding a hit. Pass the session id and seq that search_sessions returned " +
      "(shown as #id:seq). A snippet alone rarely answers anything — this shows what was actually being " +
      "discussed. Reads the source transcript, so it is exact and fast.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description:
            "Session id from search_sessions (preferred — unambiguous), or a uuid prefix. " +
            "NOTE: a uuid is NOT unique — subagent and workflow transcripts share their parent's uuid.",
        },
        seq: { type: "integer", description: "Line number of the hit, from search_sessions." },
        before: { type: "integer", description: "Messages before (default 4).", default: 4 },
        after: { type: "integer", description: "Messages after (default 6).", default: 6 },
      },
      required: ["session", "seq"],
      additionalProperties: false,
    },
  },
  {
    name: "read_session",
    title: "Read a session transcript",
    description:
      "Read a session's actual messages, in order. This is what turns a search hit into an " +
      "answer — a snippet tells you a session mentioned something, and only reading around it " +
      "tells you what was decided. Reads the source transcript and returns a forward paging cursor.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description:
            "Session id from search_sessions (preferred — unambiguous), or a uuid prefix. " +
            "NOTE: a uuid is NOT unique — subagent and workflow transcripts share their parent's uuid.",
        },
        from: {
          type: "integer",
          minimum: 1,
          description: "First seq to read: 1-based over non-empty source lines (default 1).",
          default: 1,
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "How many transcript lines to return (default 30).",
          default: 30,
        },
      },
      required: ["session"],
      additionalProperties: false,
    },
  },
  {
    name: "index_status",
    title: "Index contents and staleness",
    description:
      "What the underlying index holds (counts by tier and import status, date range) and HOW STALE it is. " +
      "This server is read-only: if the index is stale, refresh it with session-viewer's own `import`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

type Json = Record<string, unknown>;

function ok(id: unknown, result: Json): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function fail(id: unknown, code: number, message: string, data?: Json): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } });
}
/// MCP tool results carry their payload as content blocks. `resultType: "complete"` was
/// omitted by both LISTEN twins and had to be added after the fact — included here from
/// the start.
function toolResult(id: unknown, text: string): string {
  return ok(id, { content: [{ type: "text", text }], resultType: "complete", isError: false });
}
function toolError(id: unknown, text: string): string {
  return ok(id, { content: [{ type: "text", text }], resultType: "complete", isError: true });
}

async function callTool(db: Db, name: string, args: Json): Promise<string> {
  const status = indexStatus(db);
  const note = stalenessNote(status);

  switch (name) {
    case "horizons": {
      const rows = horizonOverview(db);
      const total = rows.reduce((a, r) => a + r.total, 0) || 1;
      const body = rows
        .map(
          (r) =>
            `${r.bucket.padEnd(8)} ${r.label.padEnd(9)} ${String(r.total).padStart(6)}  ` +
            `${((100 * r.total) / total).toFixed(1).padStart(5)}%`
        )
        .join("\n");
      return `${body}\n\n${note}`;
    }

    case "list_by_horizon": {
      const bucket = String(args["horizon"] ?? "");
      if (!isHorizonBucket(bucket)) {
        throw new Error(`unknown horizon "${bucket}". valid: ${HORIZON_BUCKETS.join(", ")}`);
      }
      const limit = Number(args["limit"] ?? 20);
      const l = listByHorizon(db, bucket, limit);
      if (l.sessions.length === 0) {
        return `${l.bucket} (${l.label}): no sessions.\n${note}`;
      }
      const body = l.sessions
        .map((s) => {
          const when = s.startedAt?.slice(0, 16).replace("T", " ") ?? "—";
          const desc = (s.description ?? "").replace(/\s+/g, " ").slice(0, 80);
          return `${when}  ${String(s.eventCount ?? 0).padStart(5)}ev  ${s.project ?? "—"}\n    ${desc}`;
        })
        .join("\n");
      return `${l.bucket} (${l.label}) — ${l.total} sessions, showing ${l.shown}\n\n${body}\n\n${note}`;
    }

    case "search_sessions": {
      const query = String(args["query"] ?? "");
      if (!query.trim()) throw new Error("query is required");
      const tier = args["tier"] === undefined ? undefined : String(args["tier"]);
      if (tier !== undefined && !SEARCH_TIERS.includes(tier as (typeof SEARCH_TIERS)[number])) {
        throw new Error(`unknown tier "${tier}". valid: ${SEARCH_TIERS.join(", ")}`);
      }
      const source = args["source"] === undefined ? undefined : String(args["source"]);
      if (
        source !== undefined &&
        !SEARCH_SOURCES.includes(source as (typeof SEARCH_SOURCES)[number])
      ) {
        throw new Error(`unknown source "${source}". valid: ${SEARCH_SOURCES.join(", ")}`);
      }
      const limit = Number(args["limit"] ?? DEFAULT_SEARCH_LIMIT);
      const hits = searchEventsFiltered(
        db,
        query,
        {
          project: args["project"] === undefined ? undefined : String(args["project"]),
          tier,
          source,
          since: args["since"] === undefined ? undefined : String(args["since"]),
          until: args["until"] === undefined ? undefined : String(args["until"]),
        },
        limit
      );
      if (hits.length === 0) {
        return `No matches for "${query}".\n${note}`;
      }
      const body = hits
        .map(
          (h) =>
            `#${h.sessionId}:${h.seq}  ${h.role} ${h.ts?.slice(0, 16).replace("T", " ") ?? "—"}\n    ${h.snippet}`
        )
        .join("\n");
      return (
        `${hits.length} hits for "${query}"\n\n${body}\n\n` +
        `Use read_context{session:"<id>", seq:<seq>} on any #id:seq above to see the exchange around it.\n${note}`
      );
    }

    case "index_status": {
      const li = status.lastImport;
      return (
        `index      ${db.path} (read-only)\n` +
        `sessions   ${status.totalSessions}\n` +
        `by tier    ${JSON.stringify(status.byTier)}\n` +
        `by status  ${JSON.stringify(status.byStatus)}\n` +
        `range      ${status.earliestStartedAt ?? "—"} .. ${status.latestStartedAt ?? "—"}\n` +
        (li
          ? `last import ${li.finishedAt ?? "(never finished)"} (${humanAge(li.ageSeconds)})\n`
          : "") +
        `\n${note}`
      );
    }

    case "read_context": {
      const locator = String(args["session"] ?? "");
      const seq = Number(args["seq"]);
      if (!locator || !Number.isFinite(seq)) return "session and seq are required";
      const ctx = await readContext(
        db,
        locator,
        seq,
        Number(args["before"] ?? 4),
        Number(args["after"] ?? 6)
      );
      const head =
        `session #${ctx.sessionId} ${ctx.uuid.slice(0, 8)} (${ctx.tier})  ${ctx.project ?? "—"}\n` +
        (ctx.ambiguous > 0
          ? `note: uuid prefix matched ${ctx.ambiguous} other transcript(s); showing the ${ctx.tier} tier\n`
          : "") +
        `lines ${ctx.from}-${ctx.to}, hit at ${ctx.hitSeq}\n`;
      const body = ctx.lines
        .map(
          (l) =>
            `${l.isHit ? "▶" : " "} ${String(l.seq).padStart(6)}  ${l.type.padEnd(10)} ` +
            `${l.ts?.slice(11, 16) ?? "  —  "}  ${l.text.replace(/\s+/g, " ").slice(0, 300)}`
        )
        .join("\n");
      return `${head}\n${body}\n\n${note}`;
    }

    case "read_session": {
      const locator = String(args["session"] ?? "");
      if (!locator) throw new Error("session is required");
      const page = await readSession(
        db,
        locator,
        Number(args["from"] ?? 1),
        Number(args["limit"] ?? 30)
      );
      const head =
        `session #${page.sessionId} ${page.uuid.slice(0, 8)} (${page.tier})  ${page.project ?? "—"}\n` +
        (page.ambiguous > 0
          ? `note: uuid prefix matched ${page.ambiguous} other transcript(s); showing the ${page.tier} tier\n`
          : "") +
        (page.lines.length > 0
          ? `lines ${page.lines[0]!.seq}-${page.to} (${page.lines.length})\n`
          : `no lines at or after seq ${page.from}\n`);
      const body = page.lines
        .map(
          (l) =>
            `  ${String(l.seq).padStart(6)}  ${l.type.padEnd(10)} ` +
            `${l.ts?.slice(11, 16) ?? "  —  "}  ${l.text.replace(/\s+/g, " ").slice(0, 300)}`
        )
        .join("\n");
      const paging = page.reachedEnd
        ? `reached end at seq ${page.endSeq ?? 0}`
        : `more: read_session{session:"${page.sessionId}", from:${page.nextFrom}, limit:${page.limit}}`;
      return `${head}${body ? `\n${body}\n` : "\n"}${paging}\n\n${note}`;
    }

    default:
      // Thrown, not returned as text: an unknown tool is a caller error, and
      // MCP has a real channel for that (isError: true). Returning it as plain
      // text would print "unknown tool" while claiming success.
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function runMCPServer(dbPath: string): Promise<void> {
  let db: Db;
  try {
    db = new Db(dbPath);
  } catch (err) {
    // Fail loudly on stderr — stdout belongs to the protocol and must stay clean.
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const out = (line: string) => process.stdout.write(line + "\n");

  for await (const line of readLines()) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let msg: Json;
    try {
      msg = JSON.parse(trimmed) as Json;
    } catch {
      out(fail(null, -32700, "parse error"));
      continue;
    }

    const id = msg["id"];
    const method = String(msg["method"] ?? "");
    const params = (msg["params"] ?? {}) as Json;

    switch (method) {
      case "initialize": {
        const asked = params["protocolVersion"];
        const agreed =
          typeof asked === "string" && MCP_SUPPORTED_VERSIONS.includes(asked)
            ? asked
            : MCP_HANDSHAKE_VERSIONS[0];
        out(
          ok(id, {
            protocolVersion: agreed,
            capabilities: { tools: { listChanged: true } },
            serverInfo: SERVER_INFO,
            instructions: INSTRUCTIONS,
          })
        );
        break;
      }

      // Notifications carry no id and MUST NOT be answered — replying to one is itself a
      // protocol violation.
      case "notifications/initialized":
      case "initialized":
        break;

      case "tools/list":
        out(ok(id, { tools: TOOLS }));
        break;

      case "tools/call": {
        const name = String(params["name"] ?? "");
        const args = (params["arguments"] ?? {}) as Json;
        try {
          out(toolResult(id, await callTool(db, name, args)));
        } catch (err) {
          out(toolError(id, err instanceof Error ? err.message : String(err)));
        }
        break;
      }

      case "ping":
        out(ok(id, {}));
        break;

      default:
        if (id !== undefined && id !== null) {
          out(fail(id, -32601, `method not found: ${method}`));
        }
    }
  }
}

/// Line-delimited stdin reader. Holds back a trailing partial line until its newline
/// arrives — the same discipline the transcript tailer uses, for the same reason: a
/// half-arrived JSON message must never be parsed.
async function* readLines(): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf.trim()) yield buf;
}
