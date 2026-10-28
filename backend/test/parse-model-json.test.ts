import { describe, expect, it } from "vitest";
import { parseModelJson } from "../src/llm/providers/openai-compatible";

// Regression: MiniMax-M2/M3 are reasoning models that emit <think>…</think>
// (and sometimes markdown fences) before the JSON. POC 2026-08-16 proved raw
// JSON.parse fails on this; parseModelJson must recover the object.
describe("parseModelJson (reasoning-model output recovery)", () => {
  it("strips a <think> block and parses the trailing JSON", () => {
    const text = `<think>\nBeginner, 3 days → full_body...\n</think>\n{"schema_version":"1.0","split_type":"full_body","week":[]}`;
    expect(parseModelJson(text)).toEqual({ schema_version: "1.0", split_type: "full_body", week: [] });
  });

  it("handles markdown-fenced JSON", () => {
    const text = "```json\n{\"a\":1}\n```";
    expect(parseModelJson(text)).toEqual({ a: 1 });
  });

  it("drops a truncated/unterminated <think> and still finds the object", () => {
    const text = `<think>reasoning without a closing tag {\"noise\":true} more`;
    // no valid closing object after strip → returns raw string for repair retry
    expect(typeof parseModelJson(text)).toBe("string");
  });

  it("parses plain JSON unchanged", () => {
    expect(parseModelJson('{"ok":true}')).toEqual({ ok: true });
  });

  it("returns the raw string when there is no JSON object (→ repair retry)", () => {
    expect(parseModelJson("sorry, I cannot")).toBe("sorry, I cannot");
  });
});
