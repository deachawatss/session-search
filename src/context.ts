// context.ts — transcript reading, either around a search hit or forward in pages.
//
// A snippet alone rarely answers anything: search finds WHERE something was said, and this
// shows WHAT was actually being discussed around it. It is the difference between a hit
// and an answer.
//
// READS THE SOURCE .jsonl, NOT THE INDEX — deliberately, and measured:
//
//   SELECT ... FROM events_fts WHERE session_id=? AND seq BETWEEN ?  ->  9,900 ms
//   read the file, count non-empty lines to seq                      ->      2 ms
//
// FTS5's `UNINDEXED` columns are stored but not indexed, so filtering on session_id/seq is
// a full scan of 836k rows. The transcript file is both faster and the source of truth.
// This does not violate the read-only design: v2 still writes nothing. It reads the index
// to FIND things and the transcript to SHOW them.
//
// The seq contract is inherited from the importer: seq counts NON-EMPTY lines, 1-based, in
// file order. Verified against the index — FTS seq 100 for session 318 is byte-identical to
// the 100th non-empty line of its .jsonl.

import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { Db } from "./db";
import type {
  ContextLine,
  ContextResult,
  ReadSessionResult,
  SessionLocatorRow,
  TranscriptLine,
} from "./types";
import { SELECT_SESSION_BY_ID, SELECT_SESSIONS_BY_UUID_PREFIX } from "./sql";

/// Content is either a plain string or an array of typed blocks — both shapes occur in real
/// transcripts. Non-text blocks (tool_use, tool_result, thinking) are summarized by kind
/// rather than dropped silently, so a context window never looks emptier than it was.
/// Both agents use the same block array, so one reader serves Claude's `message.content`
/// and Codex's `payload.content` / `payload.output`.
function extractBlocks(c: unknown): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  const parts: string[] = [];
  for (const b of c) {
    if (b === null || typeof b !== "object") continue;
    const blk = b as Record<string, unknown>;
    if (typeof blk["text"] === "string") parts.push(blk["text"] as string);
    else if (typeof blk["type"] === "string") parts.push(`«${blk["type"]}»`);
  }
  return parts.join("\n");
}

/// Codex wraps every record as `{timestamp, type, payload}` with no `message` key at all,
/// so the Claude reader returned "" for the whole transcript and a Codex context window
/// rendered blank. Each payload kind keeps its text in a different field; they are read
/// here rather than summarized, because a tool's own output is usually the answer someone
/// searched for.
function extractCodexPayload(payload: Record<string, unknown>): string {
  const kind = typeof payload["type"] === "string" ? (payload["type"] as string) : "";
  // Plain string carriers: the actual conversation turns.
  for (const field of ["message", "input"] as const) {
    if (typeof payload[field] === "string") {
      const name = typeof payload["name"] === "string" ? `${payload["name"]}: ` : "";
      return field === "input" ? `${name}${payload[field] as string}` : (payload[field] as string);
    }
  }
  // Block-array carriers: assistant/developer messages and tool results.
  for (const field of ["content", "output"] as const) {
    const text = extractBlocks(payload[field]);
    if (text) return text;
  }
  if (typeof payload["arguments"] === "string") {
    const name = typeof payload["name"] === "string" ? `${payload["name"]}: ` : "";
    return `${name}${payload["arguments"] as string}`;
  }
  // `reasoning` carries `summary` (often empty) plus opaque `encrypted_content`. Naming the
  // kind keeps the line honest instead of pretending it held nothing.
  const summary = extractBlocks(payload["summary"]);
  if (summary) return summary;
  return kind ? `«${kind}»` : "";
}

function extractText(obj: Record<string, unknown>): string {
  const message = obj["message"];
  if (message !== null && typeof message === "object") {
    return extractBlocks((message as Record<string, unknown>)["content"]);
  }
  const payload = obj["payload"];
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)) {
    return extractCodexPayload(payload as Record<string, unknown>);
  }
  return "";
}

/// Exported for tests only: the transcript-shape readers are the part most likely to
/// silently regress when a new agent format appears.
export const parseTranscriptLineForTest = (line: string, seq: number) =>
  parseTranscriptLine(line, seq);

function parseTranscriptLine(line: string, seq: number): TranscriptLine {
  let type = "?";
  let ts: string | null = null;
  let text = "";
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    type = typeof obj["type"] === "string" ? (obj["type"] as string) : "?";
    ts = typeof obj["timestamp"] === "string" ? (obj["timestamp"] as string) : null;
    text = extractText(obj);
  } catch {
    // A malformed line is SHOWN as malformed, never skipped — a silent gap would make
    // seq pagination lie about what is in the source transcript.
    text = "⟨unparseable line⟩";
  }
  return { seq, type, ts, text };
}

interface TranscriptRange {
  lines: TranscriptLine[];
  reachedEnd: boolean;
  endSeq: number | null;
}

/// Read at most `limit` non-empty source lines starting at the 1-based `from` seq. One
/// extra non-empty line is inspected after a full page: without that lookahead, a caller
/// cannot distinguish "exactly full final page" from "more transcript available".
async function readTranscriptRange(
  filePath: string,
  from: number,
  limit: number
): Promise<TranscriptRange> {
  const lines: TranscriptLine[] = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  let n = 0;
  let reachedEnd = true;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue; // seq counts non-empty lines only — importer's contract
      n += 1;
      if (n < from) continue;
      if (lines.length >= limit) {
        reachedEnd = false;
        break;
      }
      lines.push(parseTranscriptLine(line, n));
    }
  } finally {
    rl.close();
  }

  return { lines, reachedEnd, endSeq: reachedEnd ? n : null };
}

/// Resolve a session the caller named. Accepts the integer id (unambiguous, what search
/// returns) or a uuid prefix.
///
/// A uuid prefix is genuinely ambiguous and the code must not pretend otherwise: a
/// top-level session SHARES its uuid with every subagent and workflow-agent transcript
/// beneath it — `c80b8013` matches 173 rows on this corpus. When a prefix is given we
/// prefer the `session` tier and report how many others matched, rather than silently
/// picking one.
export function resolveSession(
  db: Db,
  locator: string
): { row: SessionLocatorRow; ambiguous: number } | null {
  if (/^\d+$/.test(locator)) {
    const row = db.handle
      .query<SessionLocatorRow, [number]>(SELECT_SESSION_BY_ID)
      .get(Number(locator));
    return row ? { row, ambiguous: 0 } : null;
  }
  const rows = db.handle
    .query<SessionLocatorRow, [string]>(SELECT_SESSIONS_BY_UUID_PREFIX)
    .all(`${locator}%`);
  if (rows.length === 0) return null;
  const top = rows.find((r) => r.file_tier === "session") ?? rows[0]!;
  return { row: top, ambiguous: rows.length - 1 };
}

export async function readContext(
  db: Db,
  locator: string,
  seq: number,
  before = 4,
  after = 6
): Promise<ContextResult> {
  const found = resolveSession(db, locator);
  if (!found) throw new Error(`no session matches "${locator}"`);
  const { row, ambiguous } = found;

  const from = Math.max(1, seq - before);
  const to = seq + after;
  // Streamed, not readFileSync — the p99 transcript here is ~40 MB and we usually want ten
  // lines from the middle of it. Stop as soon as the window is filled.
  const range = await readTranscriptRange(row.file_path, from, Math.max(0, to - from + 1));
  const lines: ContextLine[] = range.lines.map((line) => ({
    ...line,
    isHit: line.seq === seq,
  }));

  return {
    sessionId: row.id,
    uuid: row.session_uuid,
    tier: row.file_tier,
    filePath: row.file_path,
    project: row.cwd ?? row.dir_name,
    hitSeq: seq,
    from,
    to,
    ambiguous,
    lines,
  };
}

/// Read one forward page of a transcript. `from` is deliberately a seq, not a filtered
/// message index: search results and read_context already expose this 1-based non-empty-
/// line coordinate, so using it here makes `last seq + 1` a lossless paging cursor.
///
/// Every source line is retained and labeled by type. Filtering tool results, snapshots,
/// or attachments would make seqs discontinuous and could hide evidence needed to explain
/// the conversation; callers can ignore types they do not need without corrupting paging.
export async function readSession(
  db: Db,
  locator: string,
  from = 1,
  limit = 30
): Promise<ReadSessionResult> {
  if (!Number.isSafeInteger(from) || from < 1) {
    throw new Error("from must be a positive integer seq");
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("limit must be a positive integer");
  }

  const found = resolveSession(db, locator);
  if (!found) throw new Error(`no session matches "${locator}"`);
  const { row, ambiguous } = found;
  const range = await readTranscriptRange(row.file_path, from, limit);
  const to = range.lines.at(-1)?.seq ?? null;

  return {
    sessionId: row.id,
    uuid: row.session_uuid,
    tier: row.file_tier,
    filePath: row.file_path,
    project: row.cwd ?? row.dir_name,
    from,
    limit,
    to,
    ambiguous,
    reachedEnd: range.reachedEnd,
    nextFrom: range.reachedEnd || to === null ? null : to + 1,
    endSeq: range.endSeq,
    lines: range.lines,
  };
}
