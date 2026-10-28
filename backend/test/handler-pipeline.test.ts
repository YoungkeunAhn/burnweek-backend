/**
 * Pipeline wiring (B6). Uses a stub provider — no network, no cost. The real
 * MiniMax round trip lives in `scripts/run-local.cjs` / the emulator run.
 */
import { describe, expect, it } from "vitest";
import { generatePlan } from "../src/generation/handler";
import { checkWeeklyPlan } from "../src/schemas/validate";
import type { AppConfig } from "../src/config";
import type { LLMProvider } from "../src/llm";
import type { GenerateRequest, UserProfile } from "../src/generation/types";
import { editSavedWeek, type SavedWeek } from "../src/generation/edit";
import { allowedGeneratedExerciseIds, generatedPlanExerciseProblems } from "../src/generation/exercise-policy";
import { byId } from "../src/data/exercises";

const config: AppConfig = {
  llm: { provider: "stub", apiKey: "x", baseUrl: "http://localhost", model: "stub-1" },
  workerTimeoutSec: 540,
  maxRepairRetries: 2,
};

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

function request(overrides: Partial<GenerateRequest> = {}): GenerateRequest {
  return {
    user_id: "u1",
    week_start_date: "2026-08-17",
    fcm_token: "tok",
    profile: profile(),
    prior_logs: [],
    // These fixtures intentionally exercise continuity. `candidateIdsFor` keeps
    // equipment-compatible recent ids even when the beginner preset cuts them.
    recent_exercise_ids: [
      "barbell_squat",
      "barbell_bench_press_medium_grip",
      "barbell_deadlift",
      "dumbbell_shoulder_press",
    ],
    ...overrides,
  };
}

const GOOD_DRAFT = {
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

/** A draft that is schema-valid but breaks a *value* rule: 2 lifting days for 3. */
const RULE_BREAKING_DRAFT = {
  ...GOOD_DRAFT,
  week: GOOD_DRAFT.week.slice(0, 2),
};

const VERBOSE_LEGACY_DRAFT = {
  ...GOOD_DRAFT,
  week: [
    ...GOOD_DRAFT.week.map((day) => ({
      ...day,
      focus: `${day.focus} — 모델이 쓴 긴 제목`,
      items: day.items.map((item) => ({
        ...item,
        name: "모델이 쓴 이름",
        coaching_cue: "모델이 쓴 코칭 문장",
        substitution_options: ["모델이 쓴 대체 운동"],
      })),
    })),
    {
      day_index: 1,
      session_type: "cardio_only",
      focus: "모델이 쓴 유산소 날",
      items: [{ kind: "cardio", cardio_kind: { modality: "cycling", style: "LISS" } }],
    },
    { day_index: 3, session_type: "rest", focus: "모델이 쓴 휴식일", items: [] },
  ],
};

/** Fails the DraftPlan schema outright. */
const SCHEMA_BREAKING_DRAFT = { schema_version: "1.0", split_type: "nope", week: "not an array" };

function bodyweightDraft(profileValue: UserProfile) {
  const ids = allowedGeneratedExerciseIds(profileValue).slice(0, profileValue.days_per_week);
  if (ids.length !== profileValue.days_per_week) throw new Error("bodyweight fixture needs enough candidate ids");
  return {
    schema_version: "1.0",
    split_type: "full_body",
    week: ids.map((exercise_id, index) => ({
      day_index: index * 2,
      session_type: "lift",
      focus: "",
      items: [{ kind: "strength", exercise_id, role: "primary", order: 1, rep_intent: "hypertrophy" }],
    })),
  };
}

function stubProvider(drafts: unknown[]): LLMProvider & { calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  let index = 0;
  return {
    calls,
    async generateDraft({ repairFeedback }) {
      calls.push(repairFeedback);
      const draft = drafts[Math.min(index, drafts.length - 1)];
      index += 1;
      return { draft, model: "stub-1" };
    },
  } as LLMProvider & { calls: Array<string | undefined> };
}

describe("이번 주는 오늘부터 (D80 · 백로그 080)", () => {
  // request() 의 주는 2026-08-17(월). 목 10:00 KST · 일 10:00 KST.
  const THU = Date.parse("2026-08-20T10:00:00+09:00");
  const SUN = Date.parse("2026-08-23T10:00:00+09:00");
  type Plan = { plan_meta: { days_per_week: number }; week: Array<{ day_index: number; session_type: string }> };
  const liftDays = (plan: unknown) => (plan as Plan).week.filter((d) => d.session_type.startsWith("lift")).map((d) => d.day_index);

  it("T2-7 목요일 생성 — 근력·유산소 요일이 전부 목~일 · plan_meta 는 설정 회수", async () => {
    const response = await generatePlan(request(), { config, provider: stubProvider([GOOD_DRAFT]), now: THU });
    expect(response.status).toBe("ok");
    expect(liftDays(response.plan)).toHaveLength(3);
    expect((response.plan as Plan).week.every((d) => d.day_index >= 3)).toBe(true);
    expect((response.plan as Plan).plan_meta.days_per_week).toBe(3);
    expect((response.draft as Plan).week.every((d) => d.day_index >= 3)).toBe(true);
  });

  it("T2-7b 일요일 생성 — 1회(일) · 스키마 통과 · plan_meta 는 설정 회수", async () => {
    const one = { ...GOOD_DRAFT, week: [GOOD_DRAFT.week[0]] };
    const response = await generatePlan(request({ profile: profile({ split_pref: "upper_lower" }) }), { config, provider: stubProvider([one]), now: SUN });
    expect(response.status).toBe("ok");
    expect(liftDays(response.plan)).toEqual([6]);
    expect(checkWeeklyPlan(response.plan).ok).toBe(true);
    expect((response.plan as Plan).plan_meta.days_per_week).toBe(3);
  });
});

describe("pipeline wiring (B6, S-GEN-2)", () => {
  it("returns a schema-valid plan on the happy path", async () => {
    const provider = stubProvider([GOOD_DRAFT]);
    const response = await generatePlan(request(), { config, provider });

    expect(response.status).toBe("ok");
    expect(checkWeeklyPlan(response.plan).ok).toBe(true);
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]).toBeUndefined(); // no repair feedback on the first try
  });

  it("blocks hard red flags with zero LLM calls (S-GEN-1)", async () => {
    const provider = stubProvider([GOOD_DRAFT]);
    const response = await generatePlan(
      request({ profile: profile({ red_flags: { hard: ["pregnancy"], low_risk: [] } }) }),
      { config, provider },
    );

    expect(response.status).toBe("blocked_red_flag");
    expect(provider.calls).toHaveLength(0);
    expect(response.plan).toBeUndefined();
  });

  it("carries the week number the app supplied", async () => {
    const provider = stubProvider([GOOD_DRAFT]);
    const response = await generatePlan(request({ week_number: 7 }), { config, provider });
    const plan = response.plan as { plan_meta: { week_number: number; plan_id: string; source?: string } };

    expect(plan.plan_meta.week_number).toBe(7);
    expect(plan.plan_meta.plan_id).toBe("u1-w7");
    expect(plan.plan_meta.source).toBe("ai"); // D54 ① · 039 T2-3 — 생성은 AI 주다
  });

  it("treats a missing or nonsense week number as week 1", async () => {
    for (const weekNumber of [undefined, 0, -3, 2.5]) {
      const provider = stubProvider([GOOD_DRAFT]);
      const response = await generatePlan(request({ week_number: weekNumber as number }), { config, provider });
      const plan = response.plan as { plan_meta: { week_number: number } };
      expect(plan.plan_meta.week_number).toBe(1);
    }
  });
});

describe("repair retries (S-GEN-8)", () => {
  it("retries a schema-invalid draft and reports the schema errors back", async () => {
    const provider = stubProvider([SCHEMA_BREAKING_DRAFT, GOOD_DRAFT]);
    const response = await generatePlan(request(), { config, provider });

    expect(response.status).toBe("ok");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toBeTruthy();
  });

  it("retries a draft that passes the schema but breaks a value rule", async () => {
    const provider = stubProvider([RULE_BREAKING_DRAFT, GOOD_DRAFT]);
    const response = await generatePlan(request(), { config, provider });

    expect(response.status).toBe("ok");
    expect(provider.calls).toHaveLength(2);
    // The feedback must name the actual violation so the model can fix it.
    expect(provider.calls[1]).toContain("lifting sessions");
  });

  it("keeps a separate budget for each stage (S-GEN-8)", async () => {
    // One schema failure, then two rule failures, then a good draft: the schema
    // retry must not eat the rule-repair budget.
    const provider = stubProvider([
      SCHEMA_BREAKING_DRAFT,
      RULE_BREAKING_DRAFT,
      RULE_BREAKING_DRAFT,
      GOOD_DRAFT,
    ]);
    const response = await generatePlan(request(), { config, provider });

    expect(response.status).toBe("ok");
    expect(provider.calls).toHaveLength(4);
  });

  it("stops once a stage exhausts its own budget", async () => {
    const provider = stubProvider([SCHEMA_BREAKING_DRAFT]);
    const response = await generatePlan(request(), { config, provider });

    expect(response.status).toBe("error");
    // budget + 1 attempts: the initial call plus `maxRepairRetries` repairs.
    expect(provider.calls).toHaveLength(config.maxRepairRetries + 1);
    expect(response.message).toContain("DraftPlan 스키마");
  });

  it("gives up after the retry budget and says why", async () => {
    const provider = stubProvider([RULE_BREAKING_DRAFT]);
    const response = await generatePlan(request(), { config, provider });

    expect(response.status).toBe("error");
    expect(provider.calls).toHaveLength(config.maxRepairRetries + 1);
    expect(response.message).toContain("lifting sessions");
    expect(response.plan).toBeUndefined();
  });

  it("repairs a bodyweight draft that contains a real barbell exercise (071 T3)", async () => {
    const bodyProfile = profile({ environment: "bodyweight_only", equipment: [] });
    const good = bodyweightDraft(bodyProfile);
    const bad = structuredClone(good);
    bad.week[0].items[0].exercise_id = "barbell_squat";
    const provider = stubProvider([bad, good]);

    const response = await generatePlan(
      request({ profile: bodyProfile, recent_exercise_ids: ["barbell_squat"] }),
      { config, provider },
    );

    expect(response.status).toBe("ok");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toContain("outside available_exercise_ids/equipment");
    if (response.status !== "ok") return;
    const equipment = response.plan.week
      .flatMap((day) => day.exercises)
      .filter((exercise) => exercise.modality !== "cardio")
      .map((exercise) => byId(exercise.exercise_id)?.equipment);
    expect(equipment.length).toBeGreaterThan(0);
    expect(new Set(equipment)).toEqual(new Set(["body only"]));
  });

  it("returns error after the repair budget when bodyweight drafts keep using a barbell (071 T4)", async () => {
    const bodyProfile = profile({ environment: "bodyweight_only", equipment: [] });
    const bad = bodyweightDraft(bodyProfile);
    bad.week[0].items[0].exercise_id = "barbell_squat";
    const provider = stubProvider([bad]);

    const response = await generatePlan(request({ profile: bodyProfile, recent_exercise_ids: [] }), {
      config,
      provider,
    });

    expect(response.status).toBe("error");
    expect(provider.calls).toHaveLength(config.maxRepairRetries + 1);
    expect(response.message).toContain("outside available_exercise_ids/equipment");
    expect(response.plan).toBeUndefined();
  });

  it("does not retry when the engine itself throws", async () => {
    // days_per_week out of range makes chooseSplit throw — a caller bug, not a
    // bad draft, so burning more LLM calls would be pointless.
    const provider = stubProvider([GOOD_DRAFT]);
    const response = await generatePlan(request({ profile: profile({ days_per_week: 9 }) }), {
      config,
      provider,
    });

    expect(response.status).toBe("error");
    expect(response.message).toContain("플랜 확장 오류");
    expect(provider.calls).toHaveLength(1);
  });

  it("keeps the final week identical when compact output removes ignored prose, cardio, and rest days", async () => {
    const compact = await generatePlan(request(), { config, provider: stubProvider([GOOD_DRAFT]) });
    const verbose = await generatePlan(request(), { config, provider: stubProvider([VERBOSE_LEGACY_DRAFT]) });

    expect(compact.status).toBe("ok");
    expect(verbose.status).toBe("ok");
    if (compact.status !== "ok" || verbose.status !== "ok") return;
    expect(verbose.plan.week).toEqual(compact.plan.week);
  });

  it("surfaces a provider failure without retrying it", async () => {
    let calls = 0;
    const provider = {
      async generateDraft() {
        calls += 1;
        throw new Error("429 rate limited");
      },
    } as unknown as LLMProvider;

    const response = await generatePlan(request(), { config, provider });
    expect(response.status).toBe("error");
    expect(response.message).toContain("429");
    expect(calls).toBe(1);
  });
});

describe("generated exercise save guard (071 T4/T6)", () => {
  it("rejects a final bodyweight plan mutated to contain a barbell", async () => {
    const bodyProfile = profile({ environment: "bodyweight_only", equipment: [] });
    const allowed = allowedGeneratedExerciseIds(bodyProfile, ["barbell_squat"]);
    expect(allowed).not.toContain("barbell_squat");
    const response = await generatePlan(request({ profile: bodyProfile, recent_exercise_ids: [] }), {
      config,
      provider: stubProvider([bodyweightDraft(bodyProfile)]),
    });
    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;

    const mutated = structuredClone(response.plan);
    const firstStrength = mutated.week.flatMap((day) => day.exercises).find((exercise) => exercise.modality !== "cardio");
    expect(firstStrength).toBeDefined();
    firstStrength!.exercise_id = "barbell_squat";
    firstStrength!.modality = "strength";

    expect(generatedPlanExerciseProblems(mutated, bodyProfile, allowed).join(" ")).toContain("barbell_squat");
  });
});

describe("warnings reach the caller", () => {
  it("merges gate warnings with engine warnings", async () => {
    const provider = stubProvider([GOOD_DRAFT]);
    const response = await generatePlan(
      request({
        profile: profile({
          red_flags: { hard: [], low_risk: ["managed_hypertension"] },
          injuries: [{ region: "왼쪽 무릎" }],
        }),
      }),
      { config, provider },
    );

    expect(response.status).toBe("ok");
    const joined = (response.warnings ?? []).join(" ");
    expect(joined).toContain("managed_hypertension");
    expect(joined).toContain("왼쪽 무릎");
  });
});

describe("근력 요일은 생성 때 코드가 배치한다 (D46 · D56 ②)", () => {
  const liftDays = (week: unknown) =>
    (week as Array<{ day_index: number; session_type: string }>)
      .filter((d) => d.session_type === "lift" || d.session_type === "lift_plus_cardio")
      .map((d) => d.day_index);

  it("LLM 이 연속 요일을 내도 저장되는 드래프트와 플랜이 같은 벌린 요일이다", async () => {
    const consecutive = { ...GOOD_DRAFT, week: GOOD_DRAFT.week.map((d, i) => ({ ...d, day_index: 3 + i })) };
    const provider = stubProvider([consecutive]);
    const response = await generatePlan(request(), { config, provider });

    expect(response.status).toBe("ok");
    expect(provider.calls).toHaveLength(1); // 배치가 재시도를 부르지 않는다
    // 저장되는 드래프트가 LLM 요일이면 첫 편집의 재확장이 요일을 되돌린다.
    expect(liftDays((response.draft as { week: unknown }).week)).toEqual([0, 2, 4]);
    expect(liftDays((response.plan as { week: unknown }).week)).toEqual([0, 2, 4]);
  });

  it("편집 재확장은 요일을 다시 벌리지 않는다 — 사용자가 옮긴 요일이 남는다", async () => {
    const generatedProfile = profile({ available_days: [0, 2, 4] });
    const response = await generatePlan(request({ profile: generatedProfile }), { config, provider: stubProvider([GOOD_DRAFT]) });
    expect(response.status).toBe("ok");
    const saved: SavedWeek = {
      plan: response.plan,
      draft: response.draft,
      profile: generatedProfile,
      week_start_date: "2026-08-17",
      prior_logs: [],
    };
    const outcome = editSavedWeek(saved, "u1", { op: "move", day_index: 0, to_day_index: 1 }, "2026-08-17");
    // 가능요일 밖이어도 거절하지 않는다(D20 추천일 뿐) — 문제는 로그용 policyNotes 로만 남는다.
    expect(outcome.code).toBe(200);
    expect(liftDays((outcome.save!.plan as { week: unknown }).week)).toEqual([1, 2, 4]);
    expect(liftDays((outcome.save!.draft as { week: unknown }).week)).toEqual([1, 2, 4]);
    expect((outcome.policyNotes ?? []).join(" ")).toContain("lifting day 1 is not in available_days");
  });

  it("가능요일 안에서 고른다", async () => {
    const provider = stubProvider([GOOD_DRAFT]);
    const response = await generatePlan(request({ profile: profile({ available_days: [1, 3, 5] }) }), { config, provider });
    expect(response.status).toBe("ok");
    expect(liftDays((response.plan as { week: unknown }).week)).toEqual([1, 3, 5]);
  });
});

describe("완료한 날 뒤 분할 순서 위반은 재시도 프롬프트로 돌아간다 (044 N2 · D60 ② · S-GEN-8)", () => {
  const lift = (day_index: number, id: string) => ({
    day_index, session_type: "lift", focus: "x",
    items: [{ kind: "strength", exercise_id: id, role: "primary", order: 1, rep_intent: "hypertrophy" }],
  });
  const split = profile({ days_per_week: 2, available_days: [0, 1], split_pref: "upper_lower" });
  const BAD = { schema_version: "1.0", split_type: "upper_lower", week: [lift(0, "barbell_bench_press_medium_grip"), lift(1, "barbell_squat")] };
  const GOOD = { ...BAD, week: [lift(0, "barbell_bench_press_medium_grip"), lift(1, "dumbbell_shoulder_press")] };

  it("T2-6 월 하체 완료 뒤 화 하체 드래프트 → 1회 재시도 · 피드백에 슬롯 위반이 실린다", async () => {
    const provider = stubProvider([BAD, GOOD]);
    const response = await generatePlan(
      request({ profile: split, completed_this_week: [{ day_index: 0, exercise_ids: ["barbell_squat"] }] }),
      { config, provider },
    );
    expect(response.status).toBe("ok");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]).toContain("day 1 는 상체 날인데");
  });

  it("완료가 없으면 같은 드래프트가 종전대로 한 번에 통과한다(화 = 2번째 = 하체)", async () => {
    const provider = stubProvider([BAD]);
    const response = await generatePlan(request({ profile: split }), { config, provider });
    expect(response.status).toBe("ok");
    expect(provider.calls).toHaveLength(1);
  });
});
