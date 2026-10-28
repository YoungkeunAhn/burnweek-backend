import { describe, expect, it } from "vitest";
import {
  buildUserContext,
  compactDraftSchema,
  extractSelectionSignals,
  recentExerciseIds,
} from "../src/generation/prompt";
import type { GenerateRequest, UserProfile } from "../src/generation/types";
import draftPlanSchema from "../src/schemas/draft-plan.schema.json";

const PROFILE: UserProfile = {
  goals: ["build_muscle"],
  experience_level: "beginner",
  days_per_week: 3,
  session_len_min: 60,
  environment: "full_gym",
  equipment: ["barbell"],
  cardio_pref: "maintain_health",
  cardio_modalities: ["cycling"],
  injuries: [],
  red_flags: { hard: [], low_risk: [] },
};

describe("compact DraftPlan prompt schema", () => {
  it("omits engine-ignored output while preserving the compatibility schema", () => {
    const original = draftPlanSchema as Record<string, unknown>;
    const compact = compactDraftSchema(original);
    const dayProperties = (((compact.properties as Record<string, unknown>).week as Record<string, unknown>)
      .items as Record<string, unknown>).properties as Record<string, unknown>;
    const itemProperties = (((dayProperties.items as Record<string, unknown>).items as Record<string, unknown>)
      .properties as Record<string, unknown>);

    expect(dayProperties.focus).toMatchObject({ const: "" });
    expect(dayProperties.session_type).toMatchObject({ const: "lift" });
    expect(itemProperties.kind).toMatchObject({ const: "strength" });
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(original).length);
    for (const key of ["name", "cardio_kind", "substitution_options", "coaching_cue"]) {
      expect(itemProperties).not.toHaveProperty(key);
    }

    // The source schema is not mutated: stored drafts and old fixtures remain
    // valid under the existing acceptance boundary.
    const originalItemProperties = (((((original.properties as Record<string, unknown>).week as Record<string, unknown>)
      .items as Record<string, unknown>).properties as Record<string, unknown>).items as Record<string, unknown>)
      .items as Record<string, unknown>;
    expect(originalItemProperties.properties).toMatchObject({
      name: expect.any(Object),
      cardio_kind: expect.any(Object),
      substitution_options: expect.any(Object),
      coaching_cue: expect.any(Object),
    });
  });
});

/** One PerformedSession v1 with deliberately distinctive numbers + prose. */
const SESSION = {
  schema_version: "1.0",
  session_id: "s1",
  plan_id: "p1",
  date: "2026-08-10",
  day_index: 1,
  completion: "partial",
  completion_pct: 0.83,
  session_note: "무릎이 아팠음",
  exercises: [
    {
      exercise_id: "dumbbell_bench_press",
      modality: "strength",
      sets: [
        { set_number: 1, actual_reps: 19, actual_load_kg: 137.5, failed: false, pain_flag: false },
        { set_number: 2, actual_reps: 19, actual_load_kg: 137.5, failed: true, pain_flag: true },
      ],
    },
    {
      exercise_id: "bicycling_stationary",
      modality: "cardio",
      sets: [{ set_number: 1, cardio: { modality: "cycling", style: "LISS", duration_min: 43 } }],
    },
  ],
};

function request(priorLogs: unknown[]): GenerateRequest {
  return {
    user_id: "u1",
    week_start_date: "2026-08-17",
    fcm_token: "tok",
    profile: PROFILE,
    prior_logs: priorLogs,
  };
}

/** Every PerformedSession v1 field the LLM must never see (02-data-model §B3). */
const FORBIDDEN_KEYS = [
  "schema_version",
  "session_id",
  "plan_id",
  "date",
  "day_index",
  "completion_pct",
  "session_note",
  "sets",
  "set_number",
  "actual_reps",
  "actual_load_kg",
  "duration_min",
  "distance_m",
];

function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [k, ...keysOf(v)]);
  }
  return [];
}

function signalsJson(context: string): unknown {
  const body = context.match(/<prior_week_signals[^>]*>\n([\s\S]*?)\n<\/prior_week_signals>/);
  if (!body) throw new Error("prior_week_signals block missing");
  return JSON.parse(body[1]);
}

describe("INV-1 prompt boundary (design.md §3.4)", () => {
  const context = buildUserContext(request([SESSION]));

  it("forwards no numeric or free-text field, by key — not just by value", () => {
    for (const key of FORBIDDEN_KEYS) {
      expect(keysOf(signalsJson(context))).not.toContain(key);
    }
  });

  it("forwards no number at all — signals are enums, slugs and booleans only", () => {
    expect(JSON.stringify(signalsJson(context))).not.toMatch(/:\s*-?\d/);
  });

  it("withholds every numeric measurement from the LLM", () => {
    for (const numeric of ["137.5", "19", "43", "0.83"]) {
      expect(context).not.toContain(numeric);
    }
  });

  it("withholds free-text notes (pain/medical prose — design §6)", () => {
    expect(context).not.toContain("무릎이 아팠음");
  });

  it("offers real catalogue ids so the model stops inventing them", () => {
    expect(context).toContain("<available_exercise_ids");
    expect(context).toContain("barbell_squat");
  });

  it("offers ids that suit the profile's equipment", () => {
    const bodyweight = buildUserContext({
      ...request([]),
      profile: { ...PROFILE, environment: "bodyweight_only", equipment: [] },
    });
    const listed = bodyweight
      .split("<available_exercise_ids")[1]
      .split("</available_exercise_ids>")[0];
    expect(listed).not.toContain("barbell_squat");
  });

  // T1-10 (040): 입문자 프리셋 신호는 enum 한 단어뿐이다 — 렙·kg 이 프롬프트에
  // 실리면 위 「forwards no number」가 죽는다(INV-1).
  it("signals the beginner preset with an enum tag only, and keeps last week's lifts in the list (D55 ①·⑥)", () => {
    expect(context).toContain("<experience_preset>beginner</experience_preset>");
    for (const numeric of ["10–15", "1.25", "20kg"]) expect(context).not.toContain(numeric);
    const novice = buildUserContext({ ...request([]), profile: { ...PROFILE, experience_level: "novice_intermediate" } });
    expect(novice).not.toContain("<experience_preset");
    const withRecent = buildUserContext({ ...request([]), recent_exercise_ids: ["barbell_squat_to_a_bench"] });
    const listed = withRecent.split("<available_exercise_ids")[1].split("</available_exercise_ids>")[0];
    // expert 종목이라 프리셋이 잘랐을 텐데, 직전 주 종목이면 남는다.
    expect(listed).toContain("barbell_squat_to_a_bench");
    const without = buildUserContext(request([])).split("<available_exercise_ids")[1].split("</available_exercise_ids>")[0];
    expect(without).not.toContain("barbell_squat_to_a_bench");
  });

  // T3-3 (040): 중점 부위는 enum 한 단어. 숫자(「5–6종목」)는 시스템 프리픽스(고정·캐시)에만 있다.
  it("signals the focus area with an enum tag only, and not for balanced (D55 ④)", () => {
    const lower = buildUserContext({ ...request([]), profile: { ...PROFILE, focus_area: "lower" } });
    expect(lower).toContain("<focus_area>lower</focus_area>");
    expect(lower).not.toMatch(/<focus_area>[^<]*\d/);
    expect(buildUserContext({ ...request([]), profile: { ...PROFILE, focus_area: "balanced" } })).not.toContain("<focus_area");
    expect(buildUserContext(request([]))).not.toContain("<focus_area");
  });

  it("passes the non-numeric selection signals the design does allow", () => {
    expect(context).toContain("dumbbell_bench_press");
    expect(context).toContain("bicycling_stationary");
    expect(context).toContain("partial");
    expect(context).toContain("LISS");
    expect(context).toContain("<prior_week_signals");
  });
});

describe("extractSelectionSignals", () => {
  it("distills pain/failure/performed flags per exercise", () => {
    expect(extractSelectionSignals([SESSION])).toEqual([
      {
        completion: "partial",
        exercises: [
          {
            exercise_id: "dumbbell_bench_press",
            modality: "strength",
            performed: true,
            any_pain: true,
            any_failure: true,
          },
          {
            exercise_id: "bicycling_stationary",
            modality: "cardio",
            performed: true,
            any_pain: false,
            any_failure: false,
            cardio_modality: "cycling",
            cardio_style: "LISS",
          },
        ],
      },
    ]);
  });

  it("drops prose smuggled through exercise_id and out-of-enum values", () => {
    const smuggled = {
      completion: "환자 김철수, 무릎 수술 이력",
      exercises: [
        { exercise_id: "환자 메모: 어제 병원 다녀옴", modality: "strength", sets: [{ set_number: 1 }] },
        {
          exercise_id: "barbell_squat",
          modality: "자유입력 문자열",
          sets: [{ set_number: 1, cardio: { modality: "스쿠버다이빙", style: "아무거나", duration_min: 5 } }],
        },
      ],
    };
    expect(extractSelectionSignals([smuggled])).toEqual([
      {
        completion: "unknown",
        exercises: [
          {
            exercise_id: "barbell_squat",
            modality: "unknown",
            performed: true,
            any_pain: false,
            any_failure: false,
          },
        ],
      },
    ]);
  });

  it("drops malformed entries instead of throwing (prior_logs is unknown[])", () => {
    expect(extractSelectionSignals([null, "nope", 7, { exercises: [{}, { exercise_id: 1 }] }])).toEqual([
      { completion: "unknown", exercises: [] },
    ]);
  });

  it("drops ids the catalogue does not know, slug-shaped or not", () => {
    const unknownIds = {
      completion: "completed",
      exercises: [
        { exercise_id: "stationary_bike", modality: "cardio", sets: [{ set_number: 1 }] },
        { exercise_id: "kim_chulsoo_knee_surgery", modality: "strength", sets: [{ set_number: 1 }] },
      ],
    };
    expect(extractSelectionSignals([unknownIds])).toEqual([{ completion: "completed", exercises: [] }]);
  });

  it("returns an empty array on week 1 / no history (S-GEN-7)", () => {
    expect(extractSelectionSignals([])).toEqual([]);
  });
});

/** `<recent_exercises>` 블록의 본문 한 줄. 여기 밖의 것은 이 테스트의 관심사가 아니다. */
function recentBlock(ctx: string): string {
  const lines = ctx.split("\n");
  return lines[lines.indexOf("</recent_exercises>") - 1]!;
}

/**
 * 연속성 신호(`recent_exercise_ids`). 수행 로그가 없는 동안 "지금 하고 있는 운동"의
 * 유일한 원천이라, 여기서 깨지면 매주 다른 플랜이 나오는데 아무도 눈치채지 못한다.
 */
describe("직전 주 플랜 → 연속성 신호", () => {
  const plan = {
    week: [
      {
        day_index: 0,
        exercises: [
          { exercise_id: "barbell_squat", sets: [{ target_load_kg: 60 }] },
          { exercise_id: "barbell_bench_press_medium_grip", sets: [] },
        ],
      },
      { day_index: 2, exercises: [{ exercise_id: "barbell_squat", sets: [] }] },
    ],
  };

  it("종목 id 만, 중복 없이 뽑는다", () => {
    expect(recentExerciseIds(plan)).toEqual(["barbell_squat", "barbell_bench_press_medium_grip"]);
  });

  it("카탈로그에 없는 id 는 버린다 — 저장된 문서가 오염돼도 프롬프트에 닿지 않는다", () => {
    expect(recentExerciseIds({ week: [{ exercises: [{ exercise_id: "kim_chulsoo_knee_surgery" }] }] })).toEqual([]);
  });

  it("플랜이 없거나 모양이 깨져도 던지지 않는다", () => {
    for (const bad of [null, undefined, 7, "plan", {}, { week: "nope" }, { week: [null, { exercises: 3 }] }]) {
      expect(recentExerciseIds(bad)).toEqual([]);
    }
  });

  it("프롬프트에 실리되 수치는 따라가지 않는다(INV-1)", () => {
    const ctx = buildUserContext({
      user_id: "u1",
      week_start_date: "2026-08-17",
      profile: PROFILE,
      prior_logs: [],
      recent_exercise_ids: recentExerciseIds(plan),
    } as GenerateRequest);
    // 블록 안에는 id 배열뿐이다 — 직전 주 무게(60)가 따라 나오면 여기서 걸린다.
    expect(JSON.parse(recentBlock(ctx))).toEqual(["barbell_squat", "barbell_bench_press_medium_grip"]);
  });

  it("없으면 빈 배열이다 — 1주차의 정상 상태", () => {
    const ctx = buildUserContext({
      user_id: "u1",
      week_start_date: "2026-08-17",
      profile: PROFILE,
      prior_logs: [],
    } as GenerateRequest);
    expect(recentBlock(ctx)).toBe("[]");
  });
});

describe("근력 요일은 프롬프트에서도 코드가 정한 값이다 (D46)", () => {
  const ctxFor = (profile: UserProfile) =>
    buildUserContext({ user_id: "u1", week_start_date: "2026-08-17", profile, prior_logs: [] } as GenerateRequest);

  it("분할이 없는 프로필(홈짐·최소·맨몸)에도 요일 블록이 실린다", () => {
    const { split_pref: _drop, ...noSplit } = PROFILE;
    const ctx = ctxFor({ ...noSplit, environment: "minimal", days_per_week: 3, available_days: [0, 1, 2, 3, 4] });
    expect(ctx).toContain("<training_days");
    expect(ctx).toContain("월(0) 수(2) 금(4)");
  });

  it("요일 재량을 주는 문구가 없다", () => {
    const ctx = ctxFor({ ...PROFILE, split_pref: "body_part_3", days_per_week: 3 });
    expect(ctx).not.toContain("정하되");
    expect(ctx).toContain("n번째 훈련일은 <training_days> 의 n번째 요일이다");
  });
});

import { completedThisWeek } from "../src/generation/prompt";

describe("<completed_this_week> 는 요일·종목 id 뿐이다 (044 N2 · D60 ② · INV-1)", () => {
  const completed = completedThisWeek({ 1: SESSION });

  it("T2-4 세션의 수치·메모가 하나도 안 실린다 — 유산소는 빠지고 근력 id 만", () => {
    expect(completed).toEqual([{ day_index: 1, exercise_ids: ["dumbbell_bench_press"] }]);
    const context = buildUserContext({ ...request([]), completed_this_week: completed });
    expect(context).toContain("<completed_this_week");
    for (const numeric of ["137.5", "19", "43", "0.83"]) expect(context).not.toContain(numeric);
    expect(context).not.toContain("무릎이 아팠음");
    const body = context.match(/<completed_this_week note="[^"]*">\n([\s\S]*?)\n<\/completed_this_week>/)![1];
    expect(keysOf(JSON.parse(body))).toEqual(expect.arrayContaining(["day_index", "exercise_ids"]));
    for (const key of FORBIDDEN_KEYS.filter((k) => k !== "day_index")) expect(keysOf(JSON.parse(body))).not.toContain(key);
  });

  it("T2-0 완료가 없으면 프롬프트가 종전과 바이트 동일하다 — 블록 자체가 없다", () => {
    const base = buildUserContext(request([SESSION]));
    expect(buildUserContext({ ...request([SESSION]), completed_this_week: [] })).toBe(base);
    expect(base).not.toContain("completed_this_week");
  });

  it("분할표가 완료한 날 뒤로 이어진다 — 검사(splitCursor)와 같은 순서", () => {
    const split = { ...PROFILE, days_per_week: 2, available_days: [0, 1], split_pref: "upper_lower" as const };
    const context = buildUserContext({ ...request([]), profile: split, completed_this_week: [{ day_index: 0, exercise_ids: ["barbell_squat"] }] });
    const block = context.split("<split_plan")[1]!.split("</split_plan>")[0]!;
    expect(block).toContain("월(0): 완료한 날");
    expect(block).toContain("화(1): 상체");
    expect(context).toContain("완료한 부위 뒤로 순서가 이어져 있다");
    // 분할 미선택자는 정보만 받는다 — 「다음날 두지 마라」류 지시가 없다(D60 Q5 · codex N2 R1)
    const free = buildUserContext({ ...request([]), completed_this_week: [{ day_index: 0, exercise_ids: ["barbell_squat"] }] });
    expect(free).toContain("<completed_this_week");
    expect(free).not.toContain("순서가 이어져");
    expect(free).not.toContain("split_plan");
    // 완료가 없으면 종전 「n번째 훈련일」 표 그대로
    expect(buildUserContext({ ...request([]), profile: split })).toContain("1번째 훈련일: 상체");
  });

  it("세션 맵이 아니거나 카탈로그 밖 id 면 비운다", () => {
    expect(completedThisWeek(undefined)).toEqual([]);
    expect(completedThisWeek([SESSION])).toEqual([]);
    expect(completedThisWeek({ 0: { exercises: [{ exercise_id: "moon_gravity_curl", modality: "strength", sets: [] }] } })).toEqual([]);
  });
});
