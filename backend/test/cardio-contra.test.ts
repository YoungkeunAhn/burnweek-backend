import { describe, expect, it } from "vitest";
import { applyCardioOverrides, chooseModality, isHeavyLowerDay, keepForForm, parseCardioOverride, planCardio, toCardioDetail } from "../src/generation/cardio";
import { contraindicatedMuscles, excludeContraindicated } from "../src/generation/contraindications";
import { byId, type Exercise } from "../src/data/exercises";
import { allowedGeneratedExerciseIds } from "../src/generation/exercise-policy";
import type { DraftStrengthItem } from "../src/generation/expand";
import type { UserProfile } from "../src/generation/types";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 3,
    session_len_min: 45,
    environment: "full_gym",
    equipment: ["barbell", "dumbbell", "cable", "machine", "body only"],
    cardio_pref: "maintain_health",
    cardio_modalities: [],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}

function item(id: string, dayIndex: number, order = 1): DraftStrengthItem {
  const exercise = byId(id);
  if (!exercise) throw new Error(`fixture uses unknown exercise: ${id}`);
  return { dayIndex, order, exercise, role: "primary", repIntent: "hypertrophy", requestedId: id };
}

const LOWER_DAY = [item("barbell_squat", 0), item("barbell_deadlift", 0, 2)];
const UPPER_DAY = [item("barbell_bench_press_medium_grip", 2)];

describe("cardio modality choice (research/03 §3)", () => {
  it.each(["cycling", "rowing", "elliptical", "incline_walk", "running", "stairs"])(
    "bodyweight-only excludes machines even with a stale %s preference and draft proposal",
    (modality) => {
      expect(chooseModality(profile({ environment: "bodyweight_only", cardio_modalities: [modality] }), modality)).toBe("running");
    },
  );

  it("prefers low-interference modalities when the user picked none", () => {
    expect(chooseModality(profile())).toBe("cycling");
  });

  it("uses the user's own modality list first", () => {
    expect(chooseModality(profile({ cardio_modalities: ["rowing"] }))).toBe("rowing");
  });

  it("honours a draft proposal only if the user allows that modality", () => {
    expect(chooseModality(profile({ cardio_modalities: ["rowing", "cycling"] }), "cycling")).toBe("cycling");
    // Running interferes with leg training, so it needs an explicit opt-in.
    expect(chooseModality(profile(), "running")).toBe("cycling");
    expect(chooseModality(profile({ cardio_modalities: ["running"] }), "running")).toBe("running");
  });
});

describe("user cardio overrides (백로그 030 §1.1 · INV-1)", () => {
  // conditioning: HIIT 1(비하체일 2) + LISS 2 중 1(하체일 0 separate) — 휴식일에는 놓지 않는다(D45 ① · 백로그 078).
  const conditioning = profile({ cardio_pref: "conditioning" });
  const week = [...LOWER_DAY, ...UPPER_DAY];
  const base = () => planCardio(conditioning, week).sessions;

  it("목표 없이 바꾼 세션은 운동만 바뀐다 — HIIT 는 HIIT 로, 분·존·배치 그대로", () => {
    const before = base().find((s) => s.dayIndex === 2)!;
    const after = applyCardioOverrides(base(), new Map([[2, { exercise_id: "rowing_stationary" }]]), conditioning, week).find((s) => s.dayIndex === 2)!;
    expect(before.style).toBe("HIIT");
    expect(after).toEqual({ ...before, modality: "rowing", exerciseId: "rowing_stationary" });
  });

  it("옛 모양 {modality} 는 그 분류의 기본 id 로 읽는다 · 모르는 id 는 버린다 (041 N4)", () => {
    expect(parseCardioOverride({ modality: "rowing" })).toEqual({ exercise_id: "rowing_stationary" });
    expect(parseCardioOverride({ exercise_id: "step_mill", target: { style: "HIIT", duration_min: 20 } })).toEqual({ exercise_id: "step_mill", target: { style: "HIIT", duration_min: 20 } });
    expect(parseCardioOverride({ exercise_id: "prowler_sprint" })).toBeUndefined();
  });

  it("목표가 있으면 방식·분·칸을 덮고 강도존은 방식을 따른다 — 배치는 그대로 (D57 A11)", () => {
    const before = base().find((s) => s.dayIndex === 0)!; // 하체일 separate_session
    const target = { style: "HIIT" as const, duration_min: 18, level: 9, segments: [{ sec: 60, level: 12 }] };
    const after = applyCardioOverrides(base(), new Map([[0, { exercise_id: "recumbent_bike", target }]]), conditioning, week).find((s) => s.dayIndex === 0)!;
    expect(toCardioDetail(after)).toEqual({ modality: "cycling", style: "HIIT", duration_min: 18, intensity_zone: expect.stringContaining("인터벌"), placement: before.placement, level: 9, segments: [{ sec: 60, level: 12 }] });
  });

  it("keepForForm — 새 설정 방식에 있는 칸만 남긴다 (D57 A14)", () => {
    const run = { style: "HIIT" as const, duration_min: 25, distance_m: 4000, incline_pct: 2, segments: [{ label: "질주", sec: 60, speed_kmh: 12, incline_pct: 2 }] };
    expect(keepForForm(run, "walking_treadmill")).toEqual(run);
    expect(keepForForm(run, "bicycling_stationary")).toEqual({ style: "HIIT", duration_min: 25, segments: [{ label: "질주", sec: 60 }] });
    expect(keepForForm(run, "trail_running_walking")).toEqual({ style: "HIIT", duration_min: 25, distance_m: 4000, segments: [{ label: "질주", sec: 60, speed_kmh: 12 }] });
  });

  it("뺀 날만 빠지고, 없는 날에 넣으면 LISS 1회(도스 분)", () => {
    const out = applyCardioOverrides(base(), new Map<number, "none" | { exercise_id: string }>([[1, "none"], [5, { exercise_id: "elliptical_trainer" }]]), conditioning, week);
    expect(out.map((s) => s.dayIndex)).toEqual([0, 2, 5]);
    expect(out.find((s) => s.dayIndex === 5)).toMatchObject({ style: "LISS", durationMin: 25, placement: "rest_day" });
  });
});

describe("heavy-lower detection", () => {
  it("flags days holding a lower-body compound", () => {
    expect(isHeavyLowerDay(0, LOWER_DAY)).toBe(true);
    expect(isHeavyLowerDay(2, [...LOWER_DAY, ...UPPER_DAY])).toBe(false);
  });
});

describe("cardio placement (S-GEN-6)", () => {
  it.each(["maintain_health", "fat_loss", "conditioning"] as const)(
    "bodyweight-only %s uses an outdoor exercise ID for both LISS and HIIT",
    (cardio_pref) => {
      const strength = [item("pushups", 0), item("pushups", 2), item("pushups", 4)];
      const plan = planCardio(profile({ environment: "bodyweight_only", equipment: [], cardio_pref }), strength);
      expect(plan.sessions).toHaveLength(3);
      for (const session of plan.sessions) {
        expect(session).toMatchObject({ modality: "running", exerciseId: "trail_running_walking" });
      }
      expect(plan.sessions.some((session) => session.style === "HIIT")).toBe(cardio_pref === "conditioning");
    },
  );

  it("bodyweight-only still honours no-cardio and explicit user replacements", () => {
    const p = profile({ environment: "bodyweight_only", equipment: [] });
    expect(planCardio({ ...p, cardio_pref: "none" }, UPPER_DAY).sessions).toEqual([]);
    const sessions = planCardio(p, UPPER_DAY).sessions;
    const out = applyCardioOverrides(sessions, new Map([[2, { exercise_id: "bicycling_stationary" }]]), p, UPPER_DAY);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ modality: "cycling", exerciseId: "bicycling_stationary" });
  });

  it("places nothing when the preference is none", () => {
    const plan = planCardio(profile({ cardio_pref: "none" }), LOWER_DAY);
    expect(plan.sessions).toEqual([]);
  });

  // 백로그 078: 주 2회가 「근력 2일 + 유산소만 1일」= 3일로 나왔다. LISS 3회라도 근력일 2일에만 — 남는 1회는 버린다.
  it("places LISS sessions for maintain_health — lifting days only, never a rest day (D45 ①)", () => {
    const plan = planCardio(profile(), [...LOWER_DAY, ...UPPER_DAY]);
    expect(plan.sessions.map((s) => s.dayIndex)).toEqual([0, 2]);
    expect(plan.notes.join(" ")).toContain("여유가 없어");
    expect(plan.sessions.every((s) => s.style === "LISS")).toBe(true);
    expect(plan.sessions.every((s) => s.durationMin === 30)).toBe(true);
    expect(plan.sessions.every((s) => s.intensityZone.includes("Zone 2"))).toBe(true);
  });

  it("keeps HIIT off heavy-lower days — the AC", () => {
    const strength = [...LOWER_DAY, ...UPPER_DAY];
    const plan = planCardio(profile({ cardio_pref: "conditioning" }), strength);
    const hiit = plan.sessions.filter((s) => s.style === "HIIT");
    expect(hiit).toHaveLength(1);
    expect(isHeavyLowerDay(hiit[0].dayIndex, strength)).toBe(false);
  });

  it("drops HIIT rather than moving it to a rest day when every lifting day is heavy-lower (D45 ①)", () => {
    const plan = planCardio(profile({ cardio_pref: "conditioning" }), LOWER_DAY);
    expect(plan.sessions.filter((s) => s.style === "HIIT")).toEqual([]);
    expect(plan.sessions.every((s) => s.dayIndex === 0)).toBe(true);
  });

  it("drops HIIT rather than scheduling it unsafely when every day is heavy-lower", () => {
    // Lower-body compounds on all seven days: nowhere safe for HIIT.
    const everyDayLower = Array.from({ length: 7 }, (_, day) => item("barbell_squat", day));
    const plan = planCardio(profile({ cardio_pref: "conditioning" }), everyDayLower);
    expect(plan.sessions.filter((s) => s.style === "HIIT")).toEqual([]);
    expect(plan.notes.join(" ")).toContain("HIIT");
  });

  it("never puts cardio in the same session as heavy lower work (S-GEN-6)", () => {
    // Six lifting days, all heavy-lower, one rest day: the extra LISS sessions
    // have to land on heavy-lower days — as *separate* sessions, never after the
    // lifts in the same session.
    const strength = Array.from({ length: 6 }, (_, day) => item("barbell_squat", day));
    const plan = planCardio(profile(), strength);
    expect(plan.sessions.length).toBeGreaterThan(1);
    for (const session of plan.sessions) {
      if (isHeavyLowerDay(session.dayIndex, strength)) {
        expect(session.placement).toBe("separate_session");
      }
    }
    expect(plan.notes.join(" ")).toContain("별도 세션");
  });

  it("marks placement by day type", () => {
    const plan = planCardio(profile(), [...LOWER_DAY, ...UPPER_DAY]);
    for (const session of plan.sessions) {
      const onLift = [0, 2].includes(session.dayIndex);
      expect(onLift).toBe(true); // 휴식일 배치가 없다(D45 ①)
      const expected = session.dayIndex === 0 ? "separate_session" : "after_lifting";
      expect({ day: session.dayIndex, placement: session.placement }).toEqual({
        day: session.dayIndex,
        placement: expected,
      });
    }
  });

  // The bug this guards: 주 3일을 고른 사용자가 "3일 리프팅 + 3일 유산소만" 인 주를
  // 받았다. days_per_week 은 사용자가 낸 시간 예산이고, 유산소가 거기 없는 날을
  // 마음대로 쓰면 안 된다. 리프팅 날이 남아 있는 한 휴식일은 비워 둔다.
  it("fills lifting days before it spends a rest day (days_per_week is a budget)", () => {
    const strength = [item("barbell_bench_press_medium_grip", 0), item("bent_over_barbell_row", 2), item("barbell_squat", 4)];
    const plan = planCardio(profile(), strength); // maintain_health = LISS ×3
    expect(plan.sessions.map((s) => s.dayIndex)).toEqual([0, 2, 4]);
    expect(plan.sessions.some((s) => s.placement === "rest_day")).toBe(false);
  });

  it("ignores day indices outside 0–6", () => {
    const strength = [item("barbell_squat", 0), { ...item("barbell_curl", 0), dayIndex: 9 }];
    const plan = planCardio(profile(), strength);
    expect(plan.sessions.every((s) => s.dayIndex >= 0 && s.dayIndex <= 6)).toBe(true);
  });

  it("maps a session onto the cardio_detail contract shape", () => {
    const plan = planCardio(profile(), UPPER_DAY);
    const detail = toCardioDetail(plan.sessions[0]);
    expect(Object.keys(detail).sort()).toEqual([
      "duration_min",
      "intensity_zone",
      "modality",
      "placement",
      "style",
    ]);
    expect(detail.duration_min).toBeGreaterThan(0);
  });

  it("respects the weekly HIIT ceiling", () => {
    const plan = planCardio(profile({ cardio_pref: "conditioning" }), UPPER_DAY);
    expect(plan.sessions.filter((s) => s.style === "HIIT").length).toBeLessThanOrEqual(2);
  });
});

describe("contraindication mapping (G1 still open for the region list)", () => {
  it("maps a catalogue muscle name directly", () => {
    const set = contraindicatedMuscles(profile({ injuries: [{ region: "shoulders" }] }));
    expect(set.muscles).toEqual(["shoulders"]);
    expect(set.unmappedRegions).toEqual([]);
  });

  it("expands a cap group into its muscles", () => {
    const set = contraindicatedMuscles(profile({ injuries: [{ region: "back" }] }));
    expect(set.muscles).toEqual(["lats", "lower back", "middle back", "traps"]);
  });

  it("reports a region it cannot map instead of ignoring it", () => {
    const set = contraindicatedMuscles(profile({ injuries: [{ region: "왼쪽 무릎" }] }));
    expect(set.muscles).toEqual([]);
    expect(set.unmappedRegions).toEqual(["왼쪽 무릎"]);
    expect(set.warnings.join(" ")).toContain("왼쪽 무릎");
  });

  it("warns on low-risk flags, which carry no region (FR-SAFE-4)", () => {
    const set = contraindicatedMuscles(
      profile({ red_flags: { hard: [], low_risk: ["mild_joint_discomfort"] } }),
    );
    expect(set.warnings.join(" ")).toContain("mild_joint_discomfort");
  });
});

describe("contraindication exclusion (S-GEN-4)", () => {
  it("keeps everything when there is no injury", () => {
    const strength = [...LOWER_DAY, ...UPPER_DAY];
    const result = excludeContraindicated(strength, profile(), contraindicatedMuscles(profile()));
    expect(result.kept.map((k) => k.exercise.id)).toEqual(strength.map((s) => s.exercise.id));
    expect(result.excludedExerciseIds).toEqual([]);
  });

  it("excludes exercises loading the injured muscle, secondary loading included", () => {
    const injured = profile({ injuries: [{ region: "lower back" }] });
    const strength = [...LOWER_DAY, ...UPPER_DAY];
    const result = excludeContraindicated(strength, injured, contraindicatedMuscles(injured));

    // Squat loads the lower back as a secondary muscle; deadlift as its primary.
    expect(result.excludedExerciseIds).toContain("barbell_squat");
    expect(result.excludedExerciseIds).toContain("barbell_deadlift");
  });

  it("substitutes when a clean option trains a surviving primary muscle", () => {
    // Squat is primary quads + secondary lower back. Excluding the lower back
    // leaves quads, so a quad exercise that spares the back can replace it.
    const injured = profile({ injuries: [{ region: "lower back" }] });
    const result = excludeContraindicated([item("barbell_squat", 0)], injured, contraindicatedMuscles(injured));

    expect(result.kept).toHaveLength(1);
    const replacement: Exercise = result.kept[0].exercise;
    expect(replacement.id).not.toBe("barbell_squat");
    expect(replacement.primary_muscles).toContain("quadriceps");
    expect(replacement.contraindication_tags).not.toContain("lower back");
    // Like-for-like: a compound slot stays a compound.
    expect(replacement.mechanic).toBe("compound");
    expect(result.notes.join(" ")).toContain("대체");
  });

  it("keeps an AI bodyweight-only safety substitution inside the same generated candidate set", () => {
    const injured = profile({
      environment: "bodyweight_only",
      equipment: [],
      injuries: [{ region: "glutes" }],
    });
    const allowed = allowedGeneratedExerciseIds(injured);
    const result = excludeContraindicated(
      [item("bodyweight_squat", 0)],
      injured,
      contraindicatedMuscles(injured),
      allowed,
    );

    expect(result.kept).toHaveLength(1);
    expect(allowed).toContain(result.kept[0].exercise.id);
    expect(result.kept[0].exercise.equipment).toBe("body only");
  });

  it("drops the slot when nothing clean exists, rather than keeping the lift", () => {
    // The injured muscle *is* the exercise's only primary muscle.
    const injured = profile({ injuries: [{ region: "biceps" }] });
    const result = excludeContraindicated([item("barbell_curl", 0)], injured, contraindicatedMuscles(injured));

    expect(result.kept).toEqual([]);
    expect(result.excludedExerciseIds).toEqual(["barbell_curl"]);
    expect(result.notes.join(" ")).toContain("제외");
  });

  it("never substitutes an exercise already in the plan", () => {
    const injured = profile({ injuries: [{ region: "lower back" }] });
    const strength = [item("barbell_squat", 0), item("leg_press", 0, 2)];
    const result = excludeContraindicated(strength, injured, contraindicatedMuscles(injured));
    const ids = result.kept.map((k) => k.exercise.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps excluded ids out of the surviving plan — the contract invariant", () => {
    const injured = profile({ injuries: [{ region: "lower back" }] });
    const strength = [...LOWER_DAY, ...UPPER_DAY];
    const result = excludeContraindicated(strength, injured, contraindicatedMuscles(injured));

    const survivingIds = new Set(result.kept.map((k) => k.exercise.id));
    for (const excludedId of result.excludedExerciseIds) {
      expect(survivingIds.has(excludedId)).toBe(false);
    }
    // And nothing surviving loads the injured muscle.
    for (const keptItem of result.kept) {
      expect(keptItem.exercise.contraindication_tags).not.toContain("lower back");
    }
  });
});
