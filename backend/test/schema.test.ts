import { describe, expect, it } from "vitest";
import { checkDraftPlan } from "../src/schemas/validate";

describe("DraftPlan schema (contract §B1)", () => {
  it("accepts a minimal valid draft", () => {
    const draft = {
      schema_version: "1.0",
      split_type: "full_body",
      week: [
        {
          day_index: 0,
          session_type: "lift",
          focus: "full body",
          items: [
            { kind: "strength", exercise_id: "Barbell_Squat", role: "primary", rep_intent: "hypertrophy" },
          ],
        },
      ],
    };
    expect(checkDraftPlan(draft).ok).toBe(true);
  });

  it("rejects numeric fields the LLM must not emit (additionalProperties:false)", () => {
    const draft = {
      schema_version: "1.0",
      split_type: "full_body",
      week: [
        {
          day_index: 0,
          session_type: "lift",
          focus: "full body",
          items: [{ kind: "strength", exercise_id: "x", sets: 3, load_kg: 60 }],
        },
      ],
    };
    expect(checkDraftPlan(draft).ok).toBe(false);
  });

  it("rejects a bad split_type", () => {
    const draft = { schema_version: "1.0", split_type: "bro_split", week: [] };
    expect(checkDraftPlan(draft).ok).toBe(false);
  });
});
