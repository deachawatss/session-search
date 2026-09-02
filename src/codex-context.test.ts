import { describe, expect, test } from "bun:test";
import { parseTranscriptLineForTest as parse } from "./context";

/// Codex wraps every record as {timestamp, type, payload} with no `message` key, which the
/// Claude-only reader returned "" for — a Codex context window rendered blank while search
/// still found the text. These shapes are taken from real transcripts under
/// ~/.codex/sessions, not invented.
describe("Codex payload extraction", () => {
  test("reads a user turn from payload.message", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-28T21:55:34.000Z",
      type: "event_msg",
      payload: { type: "user_message", message: "install github cli in this machine" },
    });
    expect(parse(line, 1).text).toBe("install github cli in this machine");
  });

  test("reads an assistant turn from payload.message", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-28T21:55:40.000Z",
      type: "event_msg",
      payload: { type: "agent_message", message: "I'll check the operating system first." },
    });
    expect(parse(line, 2).text).toBe("I'll check the operating system first.");
  });

  test("reads tool output from a payload.output block array", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-28T21:56:00.000Z",
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: "Script completed" },
          { type: "input_text", text: "Linux Wind 6.6.87.2" },
        ],
      },
    });
    expect(parse(line, 3).text).toBe("Script completed\nLinux Wind 6.6.87.2");
  });

  test("prefixes a tool call with its name", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-28T21:56:01.000Z",
      type: "response_item",
      payload: { type: "custom_tool_call", name: "exec", input: "uname -a" },
    });
    expect(parse(line, 4).text).toBe("exec: uname -a");
  });

  test("reads a developer message from a payload.content block array", () => {
    const line = JSON.stringify({
      timestamp: "2026-07-28T21:55:35.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<permissions instructions>" }],
      },
    });
    expect(parse(line, 5).text).toBe("<permissions instructions>");
  });

  test("names an opaque kind rather than rendering an empty line", () => {
    // reasoning carries an empty summary plus encrypted_content we cannot read. A blank
    // line would misrepresent the transcript as having held nothing there.
    const line = JSON.stringify({
      timestamp: "2026-07-28T21:56:02.000Z",
      type: "response_item",
      payload: { type: "reasoning", summary: [], encrypted_content: "…" },
    });
    expect(parse(line, 6).text).toBe("«reasoning»");
  });

  test("still reads Claude's message.content shape", () => {
    const line = JSON.stringify({
      timestamp: "2026-08-12T02:01:00.000Z",
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "แก้ 2 จุด" }] },
    });
    expect(parse(line, 7).text).toBe("แก้ 2 จุด");
  });

  test("still reads Claude's plain-string content shape", () => {
    const line = JSON.stringify({
      type: "user",
      message: { role: "user", content: "hello" },
    });
    expect(parse(line, 8).text).toBe("hello");
  });

  test("shows a malformed line as malformed instead of skipping it", () => {
    expect(parse("{not json", 9).text).toBe("⟨unparseable line⟩");
  });
});
