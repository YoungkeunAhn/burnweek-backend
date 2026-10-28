import { describe, expect, it } from "vitest";
import {
  allocateVolume,
  chooseSplit,
  resolveDraft,
  weeklySets,
  type DraftStrengthItem,
} from "../src/generation/expand";
import { MEV_ANCHORS, WEEKLY_VOLUME_CAPS } from "../src/data/constants";
import { volumeTargets } from "../src/generation/expand";
import { EXERCISES, byId, capGroupsOf } from "../src/data/exercises";
import type { UserProfile } from "../src/generation/types";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 3,
    session_len_min: 45,
    environment: "full_gym",
    equipment: ["barbell", "dumbbell"],
    cardio_pref: "maintain_health",
    cardio_modalities: [],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}

/** Minimal DraftPlan shaped like the schema (§B1) — numeric-light by design. */
function draft(ids: string[], { splitType = "full_body" } = {}) {
  return {
    schema_version: "1.0",
    split_type: splitType,
    week: [
      {
        day_index: 0,
        session_type: "lift",
        focus: "full body",
        items: ids.map((id, i) => ({
          kind: "strength",
          exercise_id: id,
          role: i === 0 ? "primary" : "accessory",
          order: i + 1,
          rep_intent: "hypertrophy",
        })),
      },
    ],
  };
}

function items(ids: string[], dayIndex = 0): DraftStrengthItem[] {
  return ids.map((id, i) => {
    const exercise = byId(id);
    if (!exercise) throw new Error(`fixture uses unknown exercise: ${id}`);
    return {
      dayIndex,
      order: i + 1,
      exercise,
      role: "accessory" as const,
      repIntent: "hypertrophy" as const,
      requestedId: id,
    };
  });
}

describe("split selection (T2.1)", () => {
  it("rejects days_per_week outside 1–6 (1 = 이번 주 하루만 남은 생성 · D80 ③)", () => {
    for (const bad of [0, 7, 3.5, Number.NaN]) {
      expect(() => chooseSplit(bad)).toThrow(RangeError);
    }
  });

  it("T2-8 1회는 분할 선택과 무관하게 전신이다 (D80 ③)", () => {
    expect(chooseSplit(1)).toBe("full_body");
    expect(chooseSplit(1, "body_part_5")).toBe("full_body");
  });

  it("maps 2–6 days onto the three splits", () => {
    // `map(chooseSplit)` 로 부르지 않는다 — 배열 인덱스가 `pref` 로 들어간다.
    expect([2, 3, 4, 5, 6].map((days) => chooseSplit(days))).toEqual([
      "full_body",
      "full_body",
      "upper_lower",
      "push_pull_legs",
      "push_pull_legs",
    ]);
  });

  it("is decided by code, overriding a draft that disagrees", () => {
    const resolved = resolveDraft(draft(["barbell_squat"], { splitType: "push_pull_legs" }), profile());
    expect(resolved.splitType).toBe("full_body");
    expect(resolved.overriddenSplit).toBe("push_pull_legs");
  });

  it("reports agreement without an override note", () => {
    const resolved = resolveDraft(draft(["barbell_squat"]), profile());
    expect(resolved.overriddenSplit).toBeUndefined();
  });
});

describe("draft resolution", () => {
  it("binds model-invented ids to real exercises", () => {
    const resolved = resolveDraft(draft(["barbell_back_squat"]), profile());
    expect(resolved.strength.map((s) => s.exercise.id)).toEqual(["barbell_squat"]);
    expect(resolved.strength[0].requestedId).toBe("barbell_back_squat");
    expect(resolved.unresolvedIds).toEqual([]);
  });

  it("collects ids the catalogue cannot resolve instead of guessing", () => {
    const resolved = resolveDraft(draft(["barbell_squat", "moon_gravity_curl"]), profile());
    expect(resolved.strength.map((s) => s.exercise.id)).toEqual(["barbell_squat"]);
    expect(resolved.unresolvedIds).toEqual(["moon_gravity_curl"]);
  });

  it("reports rest-day lifts instead of scheduling them", () => {
    const restDayLift = {
      schema_version: "1.0",
      split_type: "full_body",
      week: [
        { day_index: 0, session_type: "lift", focus: "a", items: [{ kind: "strength", exercise_id: "barbell_squat", order: 1 }] },
        { day_index: 1, session_type: "rest", focus: "rest", items: [{ kind: "strength", exercise_id: "barbell_curl", order: 1 }] },
      ],
    };
    const resolved = resolveDraft(restDayLift, profile({ days_per_week: 2 }));
    expect(resolved.strength.map((s) => s.exercise.id)).toEqual(["barbell_squat"]);
    expect(resolved.problems.join(" ")).toContain("rest day");
  });

  it("reports duplicate day_index, oversized weeks and session-count mismatch", () => {
    const broken = {
      schema_version: "1.0",
      split_type: "full_body",
      week: [
        { day_index: 0, session_type: "lift", focus: "a", items: [] },
        { day_index: 0, session_type: "lift", focus: "b", items: [] },
      ],
    };
    const problems = resolveDraft(broken, profile({ days_per_week: 3 })).problems;
    expect(problems.join(" ")).toContain("duplicate day_index: 0");
    expect(problems.join(" ")).toContain("2 lifting sessions for days_per_week=3");
  });

  it("has no problems for a well-formed draft", () => {
    const ok = {
      schema_version: "1.0",
      split_type: "full_body",
      week: [
        { day_index: 0, session_type: "lift", focus: "a", items: [{ kind: "strength", exercise_id: "barbell_squat", order: 1 }] },
        { day_index: 2, session_type: "lift", focus: "b", items: [{ kind: "strength", exercise_id: "barbell_curl", order: 1 }] },
      ],
    };
    expect(resolveDraft(ok, profile({ days_per_week: 2 })).problems).toEqual([]);
  });

  it("ignores cardio items — B4 owns those", () => {
    const withCardio = {
      schema_version: "1.0",
      split_type: "full_body",
      week: [
        {
          day_index: 0,
          session_type: "lift_plus_cardio",
          focus: "full body",
          items: [
            { kind: "strength", exercise_id: "barbell_squat", order: 1 },
            { kind: "cardio", cardio_kind: { modality: "cycling", style: "LISS" }, order: 2 },
          ],
        },
      ],
    };
    expect(resolveDraft(withCardio, profile()).strength).toHaveLength(1);
  });
});

describe("focus area — 중점 쪽 상한, 반대쪽 MEV (D55 ④ · 040 T3-2)", () => {
  const LOWER = ["quads", "hamstrings", "glutes", "calves"] as const;
  const mixed = () =>
    items([
      "barbell_squat",
      "leg_press",
      "romanian_deadlift",
      "barbell_hip_thrust",
      "barbell_bench_press_medium_grip",
      "dumbbell_bench_press",
      "bent_over_barbell_row",
      "dumbbell_shoulder_press",
    ]);

  it("volumeTargets: lower 는 하체 네 그룹만 상한, upper 는 나머지만, 없음·balanced 는 전부 MEV", () => {
    const none = volumeTargets();
    expect(none).toEqual(volumeTargets("balanced"));
    for (const g of Object.keys(none) as Array<keyof typeof none>) expect(none[g]).toBe(Math.min(MEV_ANCHORS[g], WEEKLY_VOLUME_CAPS[g]));
    const lower = volumeTargets("lower");
    const upper = volumeTargets("upper");
    for (const g of Object.keys(none) as Array<keyof typeof none>) {
      const isLower = (LOWER as readonly string[]).includes(g);
      expect(lower[g]).toBe(isLower ? WEEKLY_VOLUME_CAPS[g] : none[g]);
      expect(upper[g]).toBe(isLower ? none[g] : WEEKLY_VOLUME_CAPS[g]);
    }
  });

  it("lower 는 하체 총합만 올리고 상체는 균형과 같다 — 모든 경우 상한 이하", () => {
    const base = allocateVolume(mixed()).weeklySetsByGroup;
    const lower = allocateVolume(mixed(), "lower").weeklySetsByGroup;
    const upper = allocateVolume(mixed(), "upper").weeklySetsByGroup;
    let lowerGained = 0;
    for (const [group, sets] of Object.entries(lower)) {
      const g = group as keyof typeof WEEKLY_VOLUME_CAPS;
      expect(sets).toBeLessThanOrEqual(WEEKLY_VOLUME_CAPS[g]);
      if ((LOWER as readonly string[]).includes(g)) { expect(sets).toBeGreaterThanOrEqual(base[g] ?? 0); lowerGained += sets - (base[g] ?? 0); }
      else expect(sets).toBe(base[g]);
    }
    expect(lowerGained).toBeGreaterThan(0);
    for (const [group, sets] of Object.entries(upper)) {
      const g = group as keyof typeof WEEKLY_VOLUME_CAPS;
      expect(sets).toBeLessThanOrEqual(WEEKLY_VOLUME_CAPS[g]);
      if ((LOWER as readonly string[]).includes(g)) expect(sets).toBe(base[g]);
    }
  });

  it("undefined 와 balanced 는 종전과 바이트 동일하다 — 기존 사용자 플랜 불변", () => {
    expect(allocateVolume(mixed(), "balanced")).toEqual(allocateVolume(mixed()));
    expect(allocateVolume(mixed(), undefined)).toEqual(allocateVolume(mixed()));
  });

  it("중점 쪽 종목이 상한 밖으로 많아도 트림이 그대로 돈다", () => {
    const many = items(["barbell_squat", "front_barbell_squat", "leg_press", "narrow_stance_leg_press", "hack_squat", "leg_extensions"]);
    const { weeklySetsByGroup, allocations } = allocateVolume(many, "lower");
    expect(weeklySetsByGroup.quads).toBeLessThanOrEqual(WEEKLY_VOLUME_CAPS.quads);
    expect(allocations.every((a) => a.workingSets >= 1)).toBe(true);
  });
});

describe("volume allocation (T2.2)", () => {
  it("never exceeds any weekly cap — the AC", () => {
    // Eight quad/chest exercises would blow past the caps if each got 4 sets.
    const strength = items([
      "barbell_squat",
      "front_barbell_squat",
      "leg_press",
      "narrow_stance_leg_press",
      "barbell_bench_press_medium_grip",
      "dumbbell_bench_press",
      "incline_dumbbell_press",
      "machine_bench_press",
    ]);
    const { allocations, weeklySetsByGroup } = allocateVolume(strength);

    for (const [group, sets] of Object.entries(weeklySetsByGroup)) {
      expect(sets).toBeLessThanOrEqual(WEEKLY_VOLUME_CAPS[group as keyof typeof WEEKLY_VOLUME_CAPS]);
    }
    // Nothing is starved to zero.
    expect(allocations.every((a) => a.workingSets >= 1)).toBe(true);
  });

  it("holds the cap for every plausible exercise count", () => {
    const pool = [
      "barbell_squat",
      "barbell_bench_press_medium_grip",
      "barbell_deadlift",
      "barbell_curl",
      "standing_calf_raises",
      "dumbbell_shoulder_press",
      "close_grip_front_lat_pulldown",
      "triceps_pushdown",
    ].filter((id) => byId(id));
    expect(pool.length).toBeGreaterThan(4);

    for (let count = 1; count <= pool.length; count += 1) {
      const totals = allocateVolume(items(pool.slice(0, count))).weeklySetsByGroup;
      for (const [group, sets] of Object.entries(totals)) {
        expect({ count, group, sets }).toEqual({
          count,
          group,
          sets: Math.min(sets, WEEKLY_VOLUME_CAPS[group as keyof typeof WEEKLY_VOLUME_CAPS]),
        });
      }
    }
  });

  it("keeps sets per exercise inside beginner bounds", () => {
    const { allocations } = allocateVolume(items(["barbell_squat", "barbell_bench_press_medium_grip"]));
    for (const allocation of allocations) {
      expect(allocation.workingSets).toBeGreaterThanOrEqual(2);
      expect(allocation.workingSets).toBeLessThanOrEqual(4);
    }
  });

  it("warms up only the first compound of a session", () => {
    const strength = items(["barbell_squat", "barbell_bench_press_medium_grip", "barbell_curl"]);
    const { allocations } = allocateVolume(strength);
    expect(allocations.filter((a) => a.warmupSets > 0).map((a) => a.itemIndex)).toEqual([0]);
  });

  it("warms up once per day, not once per week", () => {
    const strength = [...items(["barbell_squat"], 0), ...items(["barbell_bench_press_medium_grip"], 2)];
    const { allocations } = allocateVolume(strength);
    expect(allocations.filter((a) => a.warmupSets > 0)).toHaveLength(2);
  });

  it("charges compounds to every capped group they train", () => {
    // Deadlift's primary is the hamstrings in this catalogue; its cap group set
    // must be non-empty or volume accounting silently under-counts.
    const strength = items(["barbell_deadlift"]);
    const totals = weeklySets(strength, allocateVolume(strength).allocations);
    expect(Object.values(totals).some((sets) => sets > 0)).toBe(true);
  });

  it("returns an empty accounting for an empty draft", () => {
    const { allocations, weeklySetsByGroup } = allocateVolume([]);
    expect(allocations).toEqual([]);
    expect(Object.values(weeklySetsByGroup).every((s) => s === 0)).toBe(true);
  });

  it("drops exercises a group cannot afford at one set each (cap > count)", () => {
    // Regression: biceps cap is 10. Eleven curls used to come back at 1 set each
    // — 11 weekly sets, over the ceiling — because the trim loop bailed at 1.
    const curls = EXERCISES.filter((e) => capGroupsOf(e).includes("biceps")).slice(0, 11);
    expect(curls).toHaveLength(11);

    const strength = items(curls.map((e) => e.id));
    const plan = allocateVolume(strength);

    expect(plan.weeklySetsByGroup.biceps).toBeLessThanOrEqual(WEEKLY_VOLUME_CAPS.biceps);
    expect(plan.droppedItemIndices.length).toBeGreaterThan(0);
    // Kept items are the ones that got allocations; dropped ones get none.
    expect(plan.allocations.map((a) => a.itemIndex)).not.toContain(plan.droppedItemIndices[0]);
  });

  it("holds every cap across a brute-force sweep of same-group exercises", () => {
    for (const group of ["biceps", "quads", "chest"] as const) {
      const pool = EXERCISES.filter((e) => capGroupsOf(e).includes(group));
      for (const count of [1, 3, 8, 12, 20]) {
        if (pool.length < count) continue;
        const plan = allocateVolume(items(pool.slice(0, count).map((e) => e.id)));
        expect({ group, count, over: plan.weeklySetsByGroup[group] > WEEKLY_VOLUME_CAPS[group] }).toEqual({
          group,
          count,
          over: false,
        });
      }
    }
  });

  it("reaches the MEV anchor when the draft gives it enough exercises", () => {
    // 3 biceps exercises: MEV 6 apportions to 2+2+2 exactly.
    const pool = EXERCISES.filter((e) => capGroupsOf(e).includes("biceps")).slice(0, 3);
    const plan = allocateVolume(items(pool.map((e) => e.id)));
    expect(plan.weeklySetsByGroup.biceps).toBe(MEV_ANCHORS.biceps);
    expect(plan.shortfallByGroup.biceps).toBeUndefined();
  });

  it("bottoms out at one set per exercise when a group is packed to its cap", () => {
    // 10 biceps exercises == the cap: every one ends at exactly one working set.
    const pool = EXERCISES.filter((e) => capGroupsOf(e).includes("biceps")).slice(0, WEEKLY_VOLUME_CAPS.biceps);
    const plan = allocateVolume(items(pool.map((e) => e.id)));

    expect(plan.droppedItemIndices).toEqual([]);
    expect(plan.allocations.map((a) => a.workingSets)).toEqual(pool.map(() => 1));
    expect(plan.weeklySetsByGroup.biceps).toBe(WEEKLY_VOLUME_CAPS.biceps);
  });

  it("keeps MEV ≤ total ≤ cap — the actual invariant", () => {
    for (const group of ["biceps", "quads", "chest", "back"] as const) {
      const pool = EXERCISES.filter((e) => capGroupsOf(e).includes(group));
      for (const count of [2, 4, 6]) {
        if (pool.length < count) continue;
        const plan = allocateVolume(items(pool.slice(0, count).map((e) => e.id)));
        const total = plan.weeklySetsByGroup[group];
        expect(total).toBeLessThanOrEqual(WEEKLY_VOLUME_CAPS[group]);
        // Below MEV only ever happens with a reported shortfall.
        if (total < MEV_ANCHORS[group]) {
          expect(plan.shortfallByGroup[group]).toBe(MEV_ANCHORS[group] - total);
        }
      }
    }
  });

  it("reports a shortfall instead of hiding it when too few exercises exist", () => {
    // One chest lift can hold 4 working sets; chest MEV is 8.
    const chest = EXERCISES.find((e) => capGroupsOf(e).includes("chest"));
    const plan = allocateVolume(items([chest!.id]));
    expect(plan.weeklySetsByGroup.chest).toBeLessThan(MEV_ANCHORS.chest);
    expect(plan.shortfallByGroup.chest).toBe(MEV_ANCHORS.chest - plan.weeklySetsByGroup.chest);
  });
});
