import { describe, expect, it } from "vitest";
import { expandDraftToWeeklyPlan, presetSummary } from "../src/generation/expand";
import { checkPlanRules } from "../src/generation/plan-rules";
import { checkWeeklyPlan } from "../src/schemas/validate";
import { MEDICAL_DISCLAIMER } from "../src/generation/safety";
import { WEEKLY_VOLUME_CAPS } from "../src/data/constants";
import { byId } from "../src/data/exercises";
import type { UserProfile } from "../src/generation/types";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 3,
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

const DRAFT = {
  schema_version: "1.0",
  split_type: "full_body",
  week: [
    {
      day_index: 0,
      session_type: "lift",
      focus: "전신 A",
      items: [
        { kind: "strength", exercise_id: "barbell_squat", role: "primary", order: 1, rep_intent: "hypertrophy" },
        {
          kind: "strength",
          exercise_id: "barbell_bench_press_medium_grip",
          role: "primary",
          order: 2,
          rep_intent: "hypertrophy",
        },
      ],
    },
    {
      day_index: 2,
      session_type: "lift",
      focus: "전신 B",
      items: [
        { kind: "strength", exercise_id: "barbell_deadlift", role: "primary", order: 1, rep_intent: "hypertrophy" },
        { kind: "strength", exercise_id: "barbell_curl", role: "accessory", order: 2, rep_intent: "hypertrophy" },
      ],
    },
    {
      day_index: 4,
      session_type: "lift",
      focus: "전신 C",
      items: [
        {
          kind: "strength",
          exercise_id: "dumbbell_shoulder_press",
          role: "primary",
          order: 1,
          rep_intent: "hypertrophy",
        },
      ],
    },
  ],
};

function expand(overrides: { profile?: UserProfile; priorLogs?: unknown[]; weekNumber?: number; source?: "ai" | "manual" } = {}) {
  return expandDraftToWeeklyPlan({
    draft: DRAFT,
    profile: overrides.profile ?? profile(),
    source: overrides.source,
    userId: "u1",
    weekStartDate: "2026-08-17",
    weekNumber: overrides.weekNumber ?? 1,
    priorLogs: overrides.priorLogs ?? [],
    disclaimer: MEDICAL_DISCLAIMER,
  });
}

/**
 * PerformedSession v1 log where every working set hit the top of the range.
 * 픽스처 프로필이 beginner 라 상단은 15 다(D55 ① — 초중급은 12).
 */
function topRepsLog(exerciseId: string, kg: number) {
  return [
    {
      schema_version: "1.0",
      session_id: "s1",
      plan_id: "u1-w1",
      date: "2026-08-10",
      day_index: 0,
      completion: "completed",
      exercises: [
        {
          exercise_id: exerciseId,
          modality: "strength",
          sets: [
            { set_number: 1, set_kind: "warmup", actual_reps: 5, actual_load_kg: kg / 2 },
            { set_number: 2, set_kind: "working", actual_reps: 15, actual_load_kg: kg },
            { set_number: 3, set_kind: "working", actual_reps: 15, actual_load_kg: kg },
          ],
        },
      ],
    },
  ];
}

describe("WeeklyPlan assembly (B5, S-GEN-2)", () => {
  it("produces a plan that passes schema and every value rule", () => {
    const result = expand();
    expect(result.problems).toEqual([]);
    // Asserted independently of checkPlanRules, so a validator regression cannot
    // hide a schema regression.
    const schema = checkWeeklyPlan(result.plan);
    expect(schema.errors).toEqual([]);
    expect(schema.ok).toBe(true);
  });

  it("numbers exercise order consecutively, cardio included", () => {
    const plan = expand().plan as { week: Array<{ exercises: Array<{ order: number }> }> };
    for (const day of plan.week) {
      expect(day.exercises.map((exercise) => exercise.order)).toEqual(
        day.exercises.map((_, index) => index + 1),
      );
    }
  });

  it("carries the medical disclaimer in both documented places (S-GEN-12, INV-6)", () => {
    const plan = expand().plan as { plan_meta: { disclaimer: string }; safety: { disclaimer: string } };
    expect(plan.plan_meta.disclaimer).toBe(MEDICAL_DISCLAIMER);
    expect(plan.safety.disclaimer).toBe(MEDICAL_DISCLAIMER);
  });

  it("uses Korean exercise names and catalogue ids", () => {
    const plan = expand().plan as { week: Array<{ exercises: Array<{ exercise_id: string; name: string }> }> };
    const first = plan.week[0].exercises[0];
    expect(first.exercise_id).toBe("barbell_squat");
    expect(first.name).toBe("바벨 스쿼트");
  });

  it("publishes the caps it enforced, and stays under them", () => {
    const result = expand();
    const plan = result.plan as { safety: { weekly_volume_caps: Record<string, number> } };
    expect(plan.safety.weekly_volume_caps).toEqual(WEEKLY_VOLUME_CAPS);
    expect(result.problems).toEqual([]);
  });

  it("derives session_type from what the day actually holds", () => {
    const plan = expand().plan as { week: Array<{ day_index: number; session_type: string }> };
    const types = plan.week.map((day) => day.session_type);
    // 3 lifting days absorb the 3 LISS sessions, so the week never grows a
    // cardio-only day the user did not ask for — days_per_week is the budget.
    expect(types.every((type) => type === "lift" || type === "lift_plus_cardio")).toBe(true);
    expect(types).toContain("lift_plus_cardio");
  });

  it("keeps cardio out of the same session as heavy lower work (S-GEN-6)", () => {
    const plan = expand().plan as {
      week: Array<{
        exercises: Array<{ exercise_id: string; modality: string; cardio_detail?: { placement: string } }>;
      }>;
    };
    for (const day of plan.week) {
      const heavyLower = day.exercises.some((e) => {
        const exercise = byId(e.exercise_id);
        return (
          exercise?.mechanic === "compound" &&
          exercise.primary_muscles.some((m) => ["quadriceps", "hamstrings", "glutes", "lower back"].includes(m))
        );
      });
      const cardio = day.exercises.filter((e) => e.modality === "cardio");
      if (heavyLower && cardio.length > 0) {
        expect(cardio.every((e) => e.cardio_detail?.placement !== "after_lifting")).toBe(true);
      }
    }
  });
});

describe("week 1 fallback (S-GEN-7, T4.3)", () => {
  it("succeeds with zero prior logs", () => {
    expect(expand({ priorLogs: [] }).problems).toEqual([]);
  });

  it("prescribes no progression decision; beginners get the equipment start load, novices none (D55 ② · T2-1)", () => {
    type Plan = { week: Array<{ exercises: Array<{ exercise_id: string; progression_decision: unknown; sets?: Array<{ set_kind: string; target_load_kg: unknown }> }> }> };
    const beginner = expand({ priorLogs: [] }).plan as Plan;
    for (const day of beginner.week) {
      for (const exercise of day.exercises) {
        expect(exercise.progression_decision ?? null).toBeNull();
        const equipment = byId(exercise.exercise_id)?.equipment;
        for (const set of exercise.sets ?? []) {
          if (set.set_kind === "warmup") expect(set.target_load_kg).toBeNull();
          // 픽스처 드래프트: 바벨(20) · 덤벨 숄더프레스(복합 · 성별 없음 → 여성값 3). 나머지 장비는 없다.
          else expect(set.target_load_kg, exercise.exercise_id).toBe(equipment === "barbell" ? 20 : equipment === "dumbbell" ? 3 : null);
        }
      }
    }
    const novice = expand({ priorLogs: [], profile: profile({ experience_level: "novice_intermediate" }) }).plan as Plan;
    for (const day of novice.week) {
      for (const exercise of day.exercises) for (const set of exercise.sets ?? []) expect(set.target_load_kg).toBeNull();
    }
  });

  it("tells a first-week beginner how to find the load, and says nothing of the kind to a novice (T2-4)", () => {
    type Plan = { week: Array<{ session_type: string; warmup_note?: string }> };
    const beginner = expand({ priorLogs: [] }).plan as Plan;
    for (const day of beginner.week.filter((d) => d.session_type !== "rest")) {
      expect(day.warmup_note).toContain("가벼운 덤벨부터");
      expect(day.warmup_note).not.toContain("올려드");
      expect(day.warmup_note).not.toMatch(/\d+–\d+회/); // 렙 수는 세트 카드가 말한다
    }
    const novice = expand({ priorLogs: [], profile: profile({ experience_level: "novice_intermediate" }) }).plan as Plan;
    for (const day of novice.week) expect(day.warmup_note ?? "").not.toContain("가벼운 덤벨부터");
    // 이력이 있으면 첫 주가 아니다.
    const second = expand({ priorLogs: topRepsLog("barbell_squat", 60), weekNumber: 2 }).plan as Plan;
    for (const day of second.week) expect(day.warmup_note ?? "").not.toContain("가벼운 덤벨부터");
  });

  it("reflects only the exercises a partial week actually logged (S-GEN-7)", () => {
    const result = expand({ priorLogs: topRepsLog("barbell_squat", 60), weekNumber: 2 });
    const plan = result.plan as {
      week: Array<{ exercises: Array<{ exercise_id: string; progression_decision: { decision: string } | null }> }>;
    };
    const decisions = new Map(
      plan.week.flatMap((day) => day.exercises.map((e) => [e.exercise_id, e.progression_decision])),
    );
    expect(decisions.get("barbell_squat")?.decision).toBe("increase");
    // Nothing was logged for these, so they stay on the week-1 path.
    expect(decisions.get("barbell_curl")).toBeNull();
    expect(result.problems).toEqual([]);
  });
});

describe("week 2+ progression in the plan (S-GEN-9/10)", () => {
  it("records the decision and the resulting load", () => {
    const result = expand({ priorLogs: topRepsLog("barbell_squat", 60), weekNumber: 2 });
    const plan = result.plan as {
      week: Array<{
        exercises: Array<{
          exercise_id: string;
          progression_decision: { decision: string; reason_code: string; to_load_kg: number } | null;
          sets?: Array<{ set_kind: string; target_load_kg: number | null }>;
        }>;
      }>;
    };
    const squat = plan.week
      .flatMap((day) => day.exercises)
      .find((exercise) => exercise.exercise_id === "barbell_squat")!;

    expect(squat.progression_decision).toMatchObject({ decision: "increase", reason_code: "hit_top_reps" });
    expect(squat.progression_decision!.to_load_kg).toBe(62.5); // 입문자 하체 +2.5 (D55 ①)
    const working = (squat.sets ?? []).filter((set) => set.set_kind === "working");
    expect(working.every((set) => set.target_load_kg === 62.5)).toBe(true);
    // Warmups stay unloaded — the user ramps into the working weight.
    expect((squat.sets ?? []).filter((s) => s.set_kind === "warmup").every((s) => s.target_load_kg === null)).toBe(
      true,
    );
  });
});

describe("safety filtering inside the plan (S-GEN-4, FR-SAFE-4)", () => {
  it("records excluded exercises and keeps them out of the week", () => {
    const injured = profile({ injuries: [{ region: "lower back" }] });
    const result = expand({ profile: injured });
    const plan = result.plan as {
      week: Array<{ exercises: Array<{ exercise_id: string }> }>;
      safety: { excluded_exercise_ids: string[] };
    };

    expect(plan.safety.excluded_exercise_ids.length).toBeGreaterThan(0);
    const inWeek = new Set(plan.week.flatMap((day) => day.exercises.map((e) => e.exercise_id)));
    for (const excluded of plan.safety.excluded_exercise_ids) {
      expect(inWeek.has(excluded)).toBe(false);
    }
    expect(result.problems).toEqual([]);
  });

  it("warns on a low-risk flag rather than silently ignoring it", () => {
    const result = expand({
      profile: profile({ red_flags: { hard: [], low_risk: ["mild_joint_discomfort"] } }),
    });
    expect(result.warnings.join(" ")).toContain("mild_joint_discomfort");
  });

  it("reports an unmappable injury region", () => {
    const result = expand({ profile: profile({ injuries: [{ region: "왼쪽 무릎" }] }) });
    expect(result.warnings.join(" ")).toContain("왼쪽 무릎");
  });
});

describe("value rules catch a broken plan (T2.6)", () => {
  const good = expand().plan as Record<string, unknown>;

  const mutate = (fn: (plan: any) => void) => {
    const copy = structuredClone(good) as any;
    fn(copy);
    return checkPlanRules(copy, 3);
  };

  it("rejects a missing disclaimer", () => {
    expect(mutate((p) => (p.safety.disclaimer = "")).join(" ")).toContain("safety.disclaimer");
    expect(mutate((p) => (p.plan_meta.disclaimer = "")).join(" ")).toContain("plan_meta.disclaimer");
  });

  it("rejects a duplicate day_index", () => {
    expect(mutate((p) => (p.week[1].day_index = p.week[0].day_index)).join(" ")).toContain("duplicate day_index");
  });

  it("rejects a lifting-session count that disagrees with days_per_week", () => {
    // Drop a *lifting* day (the trailing days are cardio-only).
    const problems = mutate((p) => {
      const index = p.week.findIndex((day: any) => day.session_type.startsWith("lift"));
      p.week.splice(index, 1);
    });
    expect(problems.join(" ")).toContain("lifting sessions");
  });

  it("rejects reps_low > reps_high", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[0].sets[0].target_reps_low = 20;
      }).join(" "),
    ).toContain("reps 20 > 12"); // 입문자 복합 8–12(D104 ②)
  });

  it("rejects a volume cap breach", () => {
    expect(
      mutate((p) => {
        const sets = p.week[0].exercises[0].sets;
        for (let i = 0; i < 9; i += 1) {
          sets.push({ ...sets[sets.length - 1], set_number: sets.length + 1, set_kind: "working" });
        }
      }).join(" "),
    ).toMatch(/exceed cap|sets \(allowed/);
  });

  it("rejects an excluded exercise that reappeared in the week", () => {
    expect(
      mutate((p) => p.safety.excluded_exercise_ids.push(p.week[0].exercises[0].exercise_id)).join(" "),
    ).toContain("excluded exercise is still in the week");
  });

  it("rejects a progression decision whose reason contradicts it", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[0].progression_decision = {
          decision: "hold",
          reason_code: "hit_top_reps",
          from_load_kg: 60,
          to_load_kg: 60,
        };
      }).join(" "),
    ).toContain("cannot carry reason");
  });

  it("rejects a substitute decision that still carries a load", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[0].progression_decision = {
          decision: "substitute",
          reason_code: "pain_flag",
          from_load_kg: 60,
          to_load_kg: 55,
        };
      }).join(" "),
    ).toContain("substitute must not carry a target load");
  });

  it("rejects an exercise id the catalogue does not know", () => {
    expect(mutate((p) => (p.week[0].exercises[0].exercise_id = "moon_gravity_curl")).join(" ")).toContain(
      "unknown exercise_id",
    );
  });

  it("rejects cardio sharing a session with heavy lower work", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises.push({
          exercise_id: "bicycling_stationary",
          name: "고정식 자전거",
          modality: "cardio",
          order: 99,
          cardio_detail: {
            modality: "cycling",
            style: "LISS",
            duration_min: 30,
            intensity_zone: "Zone 2",
            placement: "after_lifting",
          },
        });
      }).join(" "),
    ).toContain("shares a session with heavy lower work");
  });

  it("rejects hold carrying first_week — week 1 uses a null decision", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[0].progression_decision = {
          decision: "hold",
          reason_code: "first_week",
          from_load_kg: null,
          to_load_kg: null,
        };
      }).join(" "),
    ).toContain("cannot carry reason");
  });

  it("rejects an increase with no target load", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[0].progression_decision = {
          decision: "increase",
          reason_code: "hit_top_reps",
          from_load_kg: 60,
          to_load_kg: null,
        };
      }).join(" "),
    ).toContain("increase needs both");
  });

  it("rejects an increase that lowers the load", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[0].progression_decision = {
          decision: "increase",
          reason_code: "hit_top_reps",
          from_load_kg: 60,
          to_load_kg: 50,
        };
      }).join(" "),
    ).toContain("must raise the load");
  });

  it("rejects a decrease that raises the load", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[0].progression_decision = {
          decision: "decrease",
          reason_code: "pain_flag",
          from_load_kg: 60,
          to_load_kg: 70,
        };
      }).join(" "),
    ).toContain("must lower the load");
  });

  it("rejects a negative load anywhere in the decision", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[0].progression_decision = {
          decision: "decrease",
          reason_code: "pain_flag",
          from_load_kg: 5,
          to_load_kg: -2.5,
        };
      }).join(" "),
    ).toContain("negative");
  });

  it("rejects working sets that disagree with the decision's target", () => {
    const problems = mutate((p) => {
      const exercise = p.week[0].exercises[0];
      exercise.progression_decision = {
        decision: "increase",
        reason_code: "hit_top_reps",
        from_load_kg: 60,
        to_load_kg: 65,
      };
      for (const set of exercise.sets) {
        if (set.set_kind === "working") set.target_load_kg = 60;
      }
    });
    expect(problems.join(" ")).toContain("disagrees with decision");
  });

  it("rejects a hold that changes the load", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[0].progression_decision = {
          decision: "hold",
          reason_code: "reps_in_progress",
          from_load_kg: 60,
          to_load_kg: 65,
        };
      }).join(" "),
    ).toContain("hold must keep the load");
  });

  it("rejects two exercises claiming the same position in a day", () => {
    expect(
      mutate((p) => {
        p.week[0].exercises[1].order = p.week[0].exercises[0].order;
      }).join(" "),
    ).toContain("duplicate exercise order");
  });

  it("checks volume against the caps the plan itself publishes", () => {
    // A tampered cap must be caught, not silently compared to the code constant.
    const problems = mutate((p) => {
      p.safety.weekly_volume_caps.quads = 1;
    });
    expect(problems.join(" ")).toContain("exceed cap 1");
  });

  it("rejects a missing or nonsensical published cap", () => {
    expect(mutate((p) => delete p.safety.weekly_volume_caps.chest).join(" ")).toContain(
      "weekly_volume_caps.chest",
    );
    expect(mutate((p) => (p.safety.weekly_volume_caps.chest = 0)).join(" ")).toContain(
      "weekly_volume_caps.chest",
    );
  });
});

describe("substitute decisions (S-GEN-11 fallout)", () => {
  it("prescribes no load and tells the user to swap the lift", () => {
    // A curl at the lightest grid step with pain logged: nothing lighter exists, so
    // the engine asks for a substitution rather than a decrease it cannot deliver.
    // (입문자 바벨 상체 격자는 1.25 — D55 ①. 장비 하한 20kg 은 N2 가 붙인다.)
    const painAtLightestLoad = [
      {
        schema_version: "1.0",
        session_id: "s1",
        plan_id: "u1-w1",
        date: "2026-08-10",
        day_index: 2,
        completion: "partial",
        exercises: [
          {
            exercise_id: "barbell_curl",
            modality: "strength",
            sets: [
              { set_number: 1, set_kind: "working", actual_reps: 8, actual_load_kg: 1.25, pain_flag: true },
            ],
          },
        ],
      },
    ];
    const result = expand({ priorLogs: painAtLightestLoad, weekNumber: 2 });
    const plan = result.plan as {
      week: Array<{
        exercises: Array<{
          exercise_id: string;
          progression_decision: { decision: string } | null;
          sets?: Array<{ set_kind: string; target_load_kg: number | null }>;
        }>;
      }>;
    };
    const curl = plan.week.flatMap((day) => day.exercises).find((e) => e.exercise_id === "barbell_curl")!;

    expect(curl.progression_decision?.decision).toBe("substitute");
    expect((curl.sets ?? []).every((set) => set.target_load_kg === null)).toBe(true);
    expect(result.warnings.join(" ")).toContain("교체");
    expect(result.problems).toEqual([]);
  });
});

describe("progression 블록의 증량값은 처방과 같다 (D55 ① · 040 T1-9)", () => {
  const progressionOf = (result: ReturnType<typeof expand>) =>
    (result.plan as { progression: { load_increment_upper_kg: number; load_increment_lower_kg: number; advance_rule: string } })
      .progression;

  it("beginner 주는 바벨 1.25/2.5 를 싣고 덤벨 2kg 를 문장에 적는다", () => {
    const p = progressionOf(expand());
    expect(p.load_increment_upper_kg).toBe(1.25);
    expect(p.load_increment_lower_kg).toBe(2.5);
    expect(p.advance_rule).toContain("덤벨·케틀벨은 2kg");
  });

  it("novice 주는 종전 2.5/5 그대로", () => {
    const p = progressionOf(expand({ profile: profile({ experience_level: "novice_intermediate" }) }));
    expect(p.load_increment_upper_kg).toBe(2.5);
    expect(p.load_increment_lower_kg).toBe(5);
  });

  it("근비대 렙은 경험 × 역할 — 입문 복합 8–12·고립 10–15, 초중급 복합 5–10·고립 8–15 (D104 ②)", () => {
    const reps = (result: ReturnType<typeof expand>) =>
      (result.plan as { week: Array<{ exercises: Array<{ sets?: Array<{ set_kind: string; target_reps_low: number; target_reps_high: number }> }> }> }).week
        .flatMap((d) => d.exercises)
        .flatMap((e) => (e.sets ?? []).filter((s) => s.set_kind === "working"))
        .map((s) => [s.target_reps_low, s.target_reps_high].join("-"));
    expect(new Set(reps(expand()))).toEqual(new Set(["8-12", "10-15"]));
    expect(new Set(reps(expand({ profile: profile({ experience_level: "novice_intermediate" }) })))).toEqual(new Set(["5-10", "8-15"]));
  });
});

describe("plan_meta.preset_summary — 최종 주에서 조립 (D55 ⑤ · 040 T4-1/T4-2)", () => {
  const lift = (id: string, kg: number | null, modality = "strength") => ({
    exercise_id: id,
    modality,
    sets: [{ set_number: 1, set_kind: "working", target_load_kg: kg }],
  });
  const week = (...exercises: Array<Record<string, unknown>>) => [{ exercises }];

  it("참만 말한다 — 장비 비율·빈 바는 실제 주에서, 입문·중점은 프로필에서 (T4-1)", () => {
    expect(presetSummary(week(lift("leg_press", null), lift("machine_bench_press", null), lift("barbell_squat", 20)), { experience_level: "beginner" }))
      .toBe("입문 플랜 · 머신·덤벨 위주 · 빈 바에서 시작");
    // 맨몸만 남은 주: 「머신·덤벨 위주」도 「빈 바」도 거짓이다.
    expect(presetSummary(week(lift("pushups", null, "bodyweight"), lift("bodyweight_squat", null, "bodyweight")), { experience_level: "beginner" })).toBe("입문 플랜");
    // 바벨이 20 이 아니면(2주차·초중급) 빈 바가 아니다.
    expect(presetSummary(week(lift("barbell_squat", 40), lift("barbell_bench_press_medium_grip", 40), lift("leg_press", null)), { experience_level: "beginner", focus_area: "lower" }))
      .toBe("입문 플랜 · 하체 중점");
    expect(presetSummary(week(lift("barbell_squat", 40)), { experience_level: "novice_intermediate", focus_area: "upper" })).toBe("상체 중점");
    expect(presetSummary(week(lift("barbell_squat", 40)), { experience_level: "novice_intermediate", focus_area: "balanced" })).toBeUndefined();
    expect(presetSummary(week(lift("barbell_squat", 40)), { experience_level: "novice_intermediate" })).toBeUndefined();
  });

  it("확장 결과에 실리고, 없을 땐 키 자체가 없다 · 스키마는 문자열만 받는다 (T4-2)", () => {
    const beginner = expand().plan as { plan_meta: Record<string, unknown> };
    expect(beginner.plan_meta.preset_summary).toBe("입문 플랜 · 빈 바에서 시작"); // 픽스처: 바벨 4 · 덤벨 1 → 비율 미달
    const novice = expand({ profile: profile({ experience_level: "novice_intermediate" }) }).plan as { plan_meta: Record<string, unknown> };
    expect("preset_summary" in novice.plan_meta).toBe(false);
    expect(checkWeeklyPlan(novice).ok).toBe(true); // 옛 플랜(필드 없음)도 통과
    const broken = structuredClone(beginner) as { plan_meta: Record<string, unknown> };
    broken.plan_meta.preset_summary = 12;
    expect(checkWeeklyPlan(broken).ok).toBe(false);
    broken.plan_meta.preset_summary = "";
    expect(checkWeeklyPlan(broken).ok).toBe(false);
  });
});

describe("plan_meta.source — 확장 입력에서만 (D54 ① · 039 T2-1/T2-2)", () => {
  it("넘긴 값만 싣고, 안 넘기면 키가 없다 · 스키마는 ai|manual 만 받는다", () => {
    type P = { plan_meta: Record<string, unknown> };
    const ai = expand({ source: "ai" }).plan as P;
    expect(ai.plan_meta.source).toBe("ai");
    expect((expand({ source: "manual" }).plan as P).plan_meta.source).toBe("manual");
    // 기본값을 "ai" 로 두면 옛 문서·수동 경로가 AI 로 불린다 — 027 #19 그 결함
    const none = expand().plan as P;
    expect("source" in none.plan_meta).toBe(false);
    expect(checkWeeklyPlan(ai).ok).toBe(true);
    expect(checkWeeklyPlan(none).ok).toBe(true);
    for (const bad of ["llm", 1, ""]) {
      const broken = structuredClone(ai);
      broken.plan_meta.source = bad;
      expect(checkWeeklyPlan(broken).ok, String(bad)).toBe(false);
    }
  });
});

describe("week numbering vs log presence (S-GEN-7)", () => {
  it("honours logs even when the request says week 1, and says so", () => {
    const result = expand({ priorLogs: topRepsLog("barbell_squat", 60), weekNumber: 1 });
    const plan = result.plan as {
      week: Array<{ exercises: Array<{ exercise_id: string; progression_decision: unknown }> }>;
    };
    const squat = plan.week.flatMap((d) => d.exercises).find((e) => e.exercise_id === "barbell_squat")!;
    expect(squat.progression_decision).not.toBeNull();
    expect(result.warnings.join(" ")).toContain("1주차로 요청");
    expect(result.problems).toEqual([]);
  });
});

/**
 * 목표 게이팅(ACSM 2026). 스키마·plan_rules 까지 통과하는지가 핵심이다 —
 * `hold` 의 사유가 `reps_in_progress` 하나뿐이라는 전제가 여기서 깨진다.
 */
describe("증량은 목표가 정한다", () => {
  const squatOf = (result: ReturnType<typeof expand>) => {
    const plan = result.plan as {
      week: Array<{
        exercises: Array<{
          exercise_id: string;
          progression_decision?: { decision: string; reason_code: string; to_load_kg: number | null };
          sets?: Array<{ set_kind: string; target_load_kg: number | null }>;
        }>;
      }>;
    };
    return plan.week.flatMap((d) => d.exercises).find((e) => e.exercise_id === "barbell_squat")!;
  };

  it("증량형이 아니면 렙 상단을 채워도 무게를 유지한다", () => {
    const result = expand({
      profile: profile({ goals: ["general_fitness", "mobility"] }),
      priorLogs: topRepsLog("barbell_squat", 60),
      weekNumber: 2,
    });
    const squat = squatOf(result);
    expect(squat.progression_decision).toMatchObject({
      decision: "hold",
      reason_code: "goal_no_overload",
      to_load_kg: 60,
    });
    // 스키마 + 값 규칙(plan-rules)까지 통과해야 실제로 살아남는 플랜이다.
    expect(result.problems).toEqual([]);
  });

  it("증량형 목표가 하나라도 있으면 올린다", () => {
    const result = expand({
      profile: profile({ goals: ["lose_fat", "gain_strength"] }),
      priorLogs: topRepsLog("barbell_squat", 60),
      weekNumber: 2,
    });
    expect(squatOf(result).progression_decision).toMatchObject({ decision: "increase", to_load_kg: 62.5 });
    expect(result.problems).toEqual([]);
  });

  it("증량형이 아니어도 통증 감량은 그대로 적용한다 — 안전은 목표와 무관하다", () => {
    const painLog = JSON.parse(JSON.stringify(topRepsLog("barbell_squat", 60)));
    for (const set of painLog[0].exercises[0].sets) set.pain_flag = true;
    const result = expand({
      profile: profile({ goals: ["general_fitness"] }),
      priorLogs: painLog,
      weekNumber: 2,
    });
    const squat = squatOf(result);
    expect(squat.progression_decision!.decision).toBe("decrease");
    expect(squat.progression_decision!.to_load_kg!).toBeLessThan(60);
    expect(result.problems).toEqual([]);
  });
});

describe("사용자가 고른 종목은 볼륨 예산에 밀려 사라지지 않는다 (D20-1)", () => {
  /** 한 근육군을 예산 초과로 채운 하루. 마지막 하나만 사용자가 고른 것이다. */
  function curlDay(userPickLast: boolean) {
    const budget = WEEKLY_VOLUME_CAPS.biceps;
    const items = Array.from({ length: budget + 1 }, (_, i) => ({
      kind: "strength",
      exercise_id: "barbell_curl",
      role: "accessory",
      order: i + 1,
      rep_intent: "hypertrophy",
      // 같은 id 를 여러 번 쓰면 resolve 가 같은 운동을 준다 — 예산 초과를 만드는
      // 가장 짧은 방법이고, 예산은 **운동 개수**로 센다.
      ...(userPickLast && i === budget ? { user_pick: true } : {}),
    }));
    return {
      schema_version: "1.0",
      split_type: "full_body",
      week: [{ day_index: 0, session_type: "lift", focus: "팔", items }],
    };
  }

  const expand = (draft: unknown) =>
    expandDraftToWeeklyPlan({
      draft,
      profile: profile({ days_per_week: 2 }),
      userId: "u1",
      weekStartDate: "2026-08-17",
      weekNumber: 1,
      priorLogs: [],
      disclaimer: MEDICAL_DISCLAIMER,
    });

  /** 근력 종목만. 유산소는 리프팅 날에 붙으므로 예산 계산과 무관하다. */
  const lifts = (result: ReturnType<typeof expand>) =>
    (result.plan as { week: Array<{ exercises: Array<{ modality: string }> }> }).week[0]!.exercises.filter(
      (exercise) => exercise.modality !== "cardio",
    );

  it("표시가 없으면 예산을 넘긴 항목이 잘린다 (생성 경로는 그대로)", () => {
    expect(lifts(expand(curlDay(false))).length).toBe(WEEKLY_VOLUME_CAPS.biceps);
  });

  it("사용자가 고른 항목은 예산을 넘겨도 남는다", () => {
    // 예산+1 개가 전부 남는다 — 밀어낼 대상이 사용자 항목뿐이라 아무것도 안 버린다.
    expect(lifts(expand(curlDay(true))).length).toBe(WEEKLY_VOLUME_CAPS.biceps + 1);
  });
});

import { assignTrainingDays, pickTrainingDays, resolveDraft } from "../src/generation/expand";

describe("근력 요일은 코드가 가능요일 안에서 정한다 (D46 · D56 ②)", () => {
  const ALL = [0, 1, 2, 3, 4, 5, 6];

  it("가장 벌어지게 — 좁은 간격 → 다음 좁은 간격 → 연속 길이 → 이른 요일", () => {
    expect(pickTrainingDays(ALL, 3)).toEqual([0, 2, 4]);
    expect(pickTrainingDays([0, 1, 2, 3, 4], 3)).toEqual([0, 2, 4]);
    expect(pickTrainingDays(ALL, 2)).toEqual([0, 3]);
    // 최소 간격만 보면 [0,1,2,3](월화수목)이 된다 — D46 이 막으려던 연속 운동.
    expect(pickTrainingDays(ALL, 4)).toEqual([0, 1, 3, 5]);
    // 간격 모양이 같으면 연속 길이가 가른다 — [0,1,2,3,5] 는 4일 연속.
    expect(pickTrainingDays(ALL, 5)).toEqual([0, 1, 2, 4, 5]);
    expect(pickTrainingDays(ALL, 6)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(pickTrainingDays([0, 2, 4, 6], 3)).toEqual([0, 2, 4]);
    expect(pickTrainingDays([6, 5], 2)).toEqual([5, 6]); // 가능 = 주당이면 그대로
  });

  const liftDay = (day_index: number, focus: string, session_type = "lift") => ({
    day_index,
    session_type,
    focus,
    items: [{ kind: "strength", exercise_id: "barbell_squat", role: "primary", order: 1, rep_intent: "hypertrophy" }],
  });

  it("드래프트에 적힌 순서대로 고른 요일에 붙이고, 휴식·유산소 전용 요일은 버린다", () => {
    const draft = {
      schema_version: "1.0",
      split_type: "full_body",
      week: [
        liftDay(1, "A"),
        { day_index: 5, session_type: "rest", focus: "휴식", items: [] },
        liftDay(2, "B", "lift_plus_cardio"),
        { day_index: 6, session_type: "cardio_only", focus: "유산소", items: [] },
        liftDay(3, "C"),
      ],
    };
    const out = assignTrainingDays(draft, profile()) as typeof draft;
    expect(out.week.map((d) => [d.day_index, d.focus, d.session_type])).toEqual([
      [0, "A", "lift"],
      [2, "B", "lift_plus_cardio"],
      [4, "C", "lift"],
    ]);
    expect(draft.week[0]!.day_index).toBe(1); // 입력은 그대로다
    expect(resolveDraft(out, profile()).problems).toEqual([]);
  });

  it("배열이 요일 순서가 아니어도 n번째 훈련일의 내용이 그대로 n번째 요일로 간다", () => {
    // 분할 적합성은 요일 오름차순으로 「n번째 훈련일」을 센다 — 배열 순서로 붙이면 부위가 엇갈려 재시도를 태운다.
    const draft = { week: [liftDay(5, "C"), liftDay(1, "A"), liftDay(3, "B")] };
    const out = assignTrainingDays(draft, profile()) as typeof draft;
    expect(out.week.map((d) => [d.day_index, d.focus])).toEqual([[0, "A"], [2, "B"], [4, "C"]]);
  });

  it("가능요일을 따른다", () => {
    const draft = { week: [liftDay(0, "A"), liftDay(1, "B"), liftDay(2, "C")] };
    const out = assignTrainingDays(draft, profile({ available_days: [1, 3, 5, 6] })) as typeof draft;
    expect(out.week.map((d) => d.day_index)).toEqual([1, 3, 5]);
  });

  it("근력 요일 수가 틀리면 손대지 않는다 — 개수 검사가 LLM 에게 되돌린다", () => {
    const draft = { week: [liftDay(1, "A"), liftDay(2, "B")] };
    expect(assignTrainingDays(draft, profile())).toBe(draft);
    expect(resolveDraft(draft, profile()).problems.join(" ")).toContain("lifting sessions");
    // 요일은 코드 몫이라 재시도 프롬프트에 요일 위반을 싣지 않는다 — 개수만 고치게 한다.
    const withDays = resolveDraft(draft, profile({ available_days: [0, 2, 4] })).problems.join(" ");
    expect(withDays).toContain("lifting sessions");
    expect(withDays).not.toContain("available_days");
  });

  it("가능요일 밖 근력 요일은 문제로 남는다(편집으로 옮긴 경우)", () => {
    const moved = { week: [liftDay(1, "A"), liftDay(2, "B"), liftDay(4, "C")] };
    const problems = resolveDraft(moved, profile({ available_days: [0, 2, 4] })).problems.join(" ");
    expect(problems).toContain("lifting day 1 is not in available_days");
    expect(resolveDraft(moved, profile()).problems.join(" ")).not.toContain("available_days"); // 필드 없음 = 제약 없음
  });
});

import { slotAssignment, splitCursor } from "../src/generation/expand";
import { splitTemplate } from "../src/data/splits";

describe("완료한 날 뒤로 분할 순서를 이어간다 (044 N2 · D60 ②)", () => {
  const day = (day_index: number, ids: string[]) => ({
    day_index, session_type: "lift", focus: "x",
    items: ids.map((id, i) => ({ kind: "strength", exercise_id: id, role: i === 0 ? "primary" : "accessory", order: i + 1, rep_intent: "hypertrophy" })),
  });
  const two = (overrides: Partial<UserProfile> = {}) => profile({ days_per_week: 2, available_days: [0, 1], split_pref: "upper_lower", ...overrides });
  const doneLegs = [{ day_index: 0, exercise_ids: ["barbell_squat"] }];
  const UL = splitTemplate("upper_lower")!;

  it("T2-1 재현 ⑤ 가 빨강 — 월 하체 완료 뒤 화 하체는 위반(화는 이어진 슬롯 = 상체) · 분할 미선택자는 그대로 통과(Q5 ㉡)", () => {
    const draft = { schema_version: "1.0", split_type: "upper_lower", week: [day(0, ["barbell_bench_press_medium_grip"]), day(1, ["barbell_squat"])] };
    expect(resolveDraft(draft, two()).problems).toEqual([]); // 완료 없음 = 종전(T2-0)
    const problems = resolveDraft(draft, two(), doneLegs).problems;
    expect(problems.join(" ")).toContain("day 1 는 상체 날인데");
    // 완료한 날이 상체였으면 다음은 하체 — 커서가 실제로 움직인다
    const doneUpper = [{ day_index: 0, exercise_ids: ["barbell_bench_press_medium_grip"] }];
    const upperDraft = { ...draft, week: [day(0, ["barbell_squat"]), day(1, ["barbell_bench_press_medium_grip"])] };
    expect(resolveDraft(upperDraft, two(), doneUpper).problems.join(" ")).toContain("day 1 는 하체 날인데");
    // 분할을 안 고른 사용자 — 재현 ⑥ 은 초록 그대로. 주 4일이라 자동 분할이 upper_lower(템플릿 있음)인데도 규칙이 안 돈다(Q5 ㉡)
    const free = { ...draft, split_type: "upper_lower", week: [day(0, ["barbell_squat"]), day(1, ["barbell_lunge"]), day(2, ["barbell_squat"]), day(3, ["barbell_lunge"])] };
    expect(resolveDraft(free, two({ split_pref: undefined, days_per_week: 4, available_days: [0, 1, 2, 3] }), doneLegs).problems).toEqual([]);
    // 옮긴 날 기준 — 화요일에 완료했으면 수요일이 그 다음
    const moved = { ...draft, week: [day(1, ["barbell_bench_press_medium_grip"]), day(2, ["barbell_squat"])] };
    expect(resolveDraft(moved, two({ available_days: [1, 2] }), [{ day_index: 1, exercise_ids: ["barbell_squat"] }]).problems.join(" ")).toContain("day 2 는 상체 날인데");
  });

  it("T2-9 완료한 요일의 항목은 검사하지 않는다 — 저장 때 옛 플랜으로 덮인다(D60 ①)", () => {
    // 종전 계산이면 day 0 = 1번째 = 상체인데 스쿼트라 위반. 완료한 날이라 통과, day 1 도 이어진 슬롯(상체)이라 통과.
    const draft = { schema_version: "1.0", split_type: "upper_lower", week: [day(0, ["barbell_squat"]), day(1, ["barbell_bench_press_medium_grip"])] };
    expect(resolveDraft(draft, two(), doneLegs).problems).toEqual([]);
  });

  it("T2-2 이어진 순서는 남은 요일 전부에 걸린다 · 주를 넘지 않는다(Q6 ㉡)", () => {
    // 월 하체 완료 · 남은 훈련일 목요일 하나 → 상체
    const p = two({ available_days: [0, 3] });
    expect(resolveDraft({ schema_version: "1.0", split_type: "upper_lower", week: [day(0, ["barbell_bench_press_medium_grip"]), day(3, ["barbell_squat"])] }, p, doneLegs).problems.join(" ")).toContain("day 3 는 상체 날인데");
    expect(resolveDraft({ schema_version: "1.0", split_type: "upper_lower", week: [day(0, ["barbell_bench_press_medium_grip"]), day(3, ["barbell_bench_press_medium_grip"])] }, p, doneLegs).problems).toEqual([]);
    // 일요일 완료는 이번 주 남은 날이 없다 — 다음 주 월요일을 막지 않는다(접수가 직전 주를 안 읽는다 · T2-7)
    expect(resolveDraft({ schema_version: "1.0", split_type: "upper_lower", week: [day(0, ["barbell_bench_press_medium_grip"]), day(6, ["barbell_squat"])] }, two({ available_days: [0, 6] }), [{ day_index: 6, exercise_ids: ["barbell_squat"] }]).problems).toEqual([]);
  });

  it("T2-10 건너뛴 지난 요일이 커서를 먼저 소비하지 않는다 — 마지막 완료일 뒤 요일이 먼저 잇는다(codex N2 R1)", () => {
    // 주 4일 월~목 · 월 건너뜀 · 화 하체 · 수 상체 완료 → 목은 하체(수 상체의 다음), 월(지난 날)은 그 다음 = 상체
    const p = profile({ days_per_week: 4, available_days: [0, 1, 2, 3], split_pref: "upper_lower" });
    const doneTueWed = [{ day_index: 1, exercise_ids: ["barbell_squat"] }, { day_index: 2, exercise_ids: ["barbell_bench_press_medium_grip"] }];
    const thuUpper = { schema_version: "1.0", split_type: "upper_lower", week: [day(0, ["barbell_squat"]), day(1, ["barbell_squat"]), day(2, ["barbell_curl"]), day(3, ["barbell_bench_press_medium_grip"])] };
    expect(resolveDraft(thuUpper, p, doneTueWed).problems.join(" ")).toContain("day 3 는 하체 날인데");
    const thuLower = { ...thuUpper, week: [day(0, ["barbell_bench_press_medium_grip"]), day(1, ["barbell_squat"]), day(2, ["barbell_curl"]), day(3, ["barbell_squat"])] };
    expect(resolveDraft(thuLower, p, doneTueWed).problems).toEqual([]);
    const map = slotAssignment(UL, [0, 1, 2, 3], doneTueWed);
    expect([...map.entries()].map(([d, s]) => [d, s.label])).toEqual([[3, "하체"], [0, "상체"]]);
  });

  it("T2-3 슬롯은 축(D24-1)으로 찾는다 — 이두는 상체에 붙고, 복근만 한 날은 슬롯이 없다", () => {
    expect(splitCursor(UL, [])).toBe(0);
    expect(splitCursor(UL, [{ day_index: 0, exercise_ids: ["barbell_squat"] }])).toBe(0); // 하체(1) 다음 = 상체(0) — (1+1)%2
    expect(splitCursor(UL, [{ day_index: 0, exercise_ids: ["barbell_curl"] }])).toBe(1); // 이두 → 상체(0) 다음 = 하체(1)
    expect(splitCursor(UL, [{ day_index: 0, exercise_ids: ["barbell_bench_press_medium_grip"] }])).toBe(1);
    expect(splitCursor(UL, [{ day_index: 0, exercise_ids: [] }])).toBe(0);
    const BP3 = splitTemplate("body_part_3")!;
    expect(splitCursor(BP3, [{ day_index: 0, exercise_ids: ["barbell_squat"] }])).toBe(0); // 하체·어깨(2) 다음 = 가슴·삼두(0)
    expect(splitCursor(BP3, [{ day_index: 0, exercise_ids: ["barbell_bench_press_medium_grip"] }])).toBe(1);
    // 마지막 완료일이 기준 — 월 가슴, 수 등 → 목 = 하체
    expect(splitCursor(BP3, [{ day_index: 2, exercise_ids: ["barbell_curl"] }, { day_index: 0, exercise_ids: ["barbell_bench_press_medium_grip"] }])).toBe(2);
  });
});
