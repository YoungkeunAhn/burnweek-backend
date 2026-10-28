import { describe, expect, it } from "vitest";
import { evaluateGate } from "../src/generation/red-flags";
import type { UserProfile } from "../src/generation/types";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 3,
    session_len_min: 60,
    environment: "full_gym",
    equipment: ["barbell", "dumbbell"],
    cardio_pref: "maintain_health",
    cardio_modalities: ["cycling"],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}

describe("red-flag generation gate (FR-SAFE-3/4)", () => {
  it("blocks when a hard flag is present", () => {
    const g = evaluateGate(profile({ red_flags: { hard: ["pregnancy"], low_risk: [] } }));
    expect(g.blocked).toBe(true);
    expect(g.hardHits).toEqual(["pregnancy"]);
  });

  it("does not block on low-risk flags, but surfaces warnings", () => {
    const g = evaluateGate(
      profile({ red_flags: { hard: [], low_risk: ["managed_hypertension"] } }),
    );
    expect(g.blocked).toBe(false);
    expect(g.warnings).toContain("low_risk_flag:managed_hypertension");
  });

  it("passes clean profiles with no warnings", () => {
    const g = evaluateGate(profile());
    expect(g.blocked).toBe(false);
    expect(g.warnings).toEqual([]);
  });
});
