import { describe, expect, it } from "vitest";
import { byId } from "../src/data/exercises";
import { allowedGeneratedExerciseIds } from "../src/generation/exercise-policy";
import { resolveDraft } from "../src/generation/expand";
import type { UserProfile } from "../src/generation/types";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 2,
    session_len_min: 45,
    environment: "full_gym",
    equipment: ["barbell", "dumbbell", "machine", "cable", "body only"],
    cardio_pref: "maintain_health",
    cardio_modalities: [],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}

function draft(exerciseId: string, userPick = false) {
  return {
    schema_version: "1.0",
    split_type: "full_body",
    week: [
      {
        day_index: 0,
        session_type: "lift",
        focus: "",
        items: [
          {
            kind: "strength",
            exercise_id: exerciseId,
            role: "primary",
            order: 1,
            rep_intent: "hypertrophy",
            ...(userPick ? { user_pick: true } : {}),
          },
        ],
      },
    ],
  };
}

describe("AI-generated exercise policy (071)", () => {
  it("rejects a real barbell id for a bodyweight-only profile (T1)", () => {
    const p = profile({ environment: "bodyweight_only", equipment: [] });
    const allowed = allowedGeneratedExerciseIds(p);
    const resolved = resolveDraft(draft("barbell_squat"), p, [], allowed);

    expect(allowed).not.toContain("barbell_squat");
    expect(resolved.strength).toHaveLength(0);
    expect(resolved.problems.join(" ")).toContain("outside available_exercise_ids/equipment");
  });

  it("accepts candidate ids and every resulting bodyweight exercise uses body-only equipment (T2)", () => {
    const p = profile({ environment: "bodyweight_only", equipment: [] });
    const allowed = allowedGeneratedExerciseIds(p);
    const exerciseId = allowed[0];
    const resolved = resolveDraft(draft(exerciseId), p, [], allowed);

    expect(exerciseId).toBeTruthy();
    expect(resolved.problems.join(" ")).not.toContain("outside available_exercise_ids/equipment");
    expect(resolved.strength).toHaveLength(1);
    expect(byId(resolved.strength[0].exercise.id)?.equipment).toBe("body only");
  });

  it.each([
    ["bodyweight_only", [], "barbell_squat"],
    ["home_gym", ["dumbbell", "body only"], "barbell_squat"],
    ["minimal", ["bands", "body only"], "barbell_squat"],
    ["full_gym", ["barbell", "dumbbell", "machine", "cable", "body only"], "goblet_squat"],
  ] as const)("enforces candidates and equipment for %s (T5)", (environment, equipment, disallowedId) => {
    const p = profile({ environment, equipment: [...equipment] });
    const allowed = allowedGeneratedExerciseIds(p);
    const resolved = resolveDraft(draft(disallowedId), p, [], allowed);

    expect(allowed).not.toContain(disallowedId);
    expect(resolved.problems.join(" ")).toContain("outside available_exercise_ids/equipment");
  });

  it("does not restore an equipment-incompatible recent exercise (T6)", () => {
    const p = profile({ environment: "bodyweight_only", equipment: [] });
    const allowed = allowedGeneratedExerciseIds(p, ["barbell_squat"]);

    expect(allowed).not.toContain("barbell_squat");
    expect(allowed.length).toBeGreaterThan(0);
    expect(allowed.every((id) => byId(id)?.equipment === "body only")).toBe(true);
  });

  it("compares the canonical resolved id with the allowed set", () => {
    const p = profile();
    const allowed = allowedGeneratedExerciseIds(p, ["barbell_squat"]);
    const resolved = resolveDraft(draft("barbell_back_squat"), p, [], allowed);

    expect(resolved.strength[0]?.exercise.id).toBe("barbell_squat");
    expect(resolved.problems.join(" ")).not.toContain("outside available_exercise_ids/equipment");
  });

  it("keeps the manual user-pick escape hatch outside the AI generation boundary (T8)", () => {
    const p = profile({ environment: "bodyweight_only", equipment: [] });
    const manual = resolveDraft(draft("barbell_squat", true), p);
    const generated = resolveDraft(draft("barbell_squat", true), p, [], allowedGeneratedExerciseIds(p));

    expect(manual.strength.map((item) => item.exercise.id)).toEqual(["barbell_squat"]);
    expect(manual.problems.join(" ")).not.toContain("outside available_exercise_ids/equipment");
    expect(generated.strength).toHaveLength(0);
    expect(generated.problems.join(" ")).toContain("outside available_exercise_ids/equipment");
  });
});
