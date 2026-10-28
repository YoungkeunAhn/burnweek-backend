/**
 * 지난 유산소 기록이 다음 주 목표가 된다 — [D57] A10·A11 · 041 N6(T6-1~T6-9).
 *
 * 지금까지 유산소는 `CARDIO_DOSE` 고정값이었다: 지난주 45분을 뛰었어도 이번 주는 다시 30분.
 * 근력은 `prescribeLoad` 가 이미 직전 주 수치를 읽는데 유산소만 빠져 있었다(`priorSetsFor` 가
 * `set.cardio` 를 건너뛴다). **생성 방식은 안 가린다**(사용자 결정 2026-09-16) — LLM 은 프롬프트에서
 * 비수치 신호만 받으므로 AI 주라고 해서 지난 기록이 반영돼 있지 않다.
 */
import { describe, expect, it } from "vitest";
import { cardioTargetFromPriorLogs } from "../src/generation/cardio";
import { expandDraftToWeeklyPlan } from "../src/generation/expand";
import { exerciseHistory } from "../src/generation/history";
import { MEDICAL_DISCLAIMER } from "../src/generation/safety";
import { checkWeeklyPlan } from "../src/schemas/validate";
import type { SavedWeek } from "../src/generation/edit";
import type { UserProfile } from "../src/generation/types";

const RUN = "running_treadmill";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 3,
    session_len_min: 45,
    environment: "full_gym",
    equipment: ["barbell", "dumbbell", "machine", "cable", "body only"],
    cardio_pref: "maintain_health",
    // 러닝을 갖고 있다고 해야 러닝 줄이 놓인다(기본 선호는 cycling·rowing) — 복사는
    // **그 날 놓인 운동의 id** 로 지난 기록을 찾는다([D57] A10 「같은 운동」).
    cardio_modalities: ["running"],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}

/** 유산소 세트 하나가 든 세션. 미니앱 `toPerformedSession` 이 싣는 모양 그대로다. */
const session = (dayIndex: number, date: string, exerciseId: string, cardio: Record<string, unknown>) => ({
  session_id: `s-${dayIndex}`,
  day_index: dayIndex,
  date,
  completion: "completed",
  exercises: [{ exercise_id: exerciseId, modality: "cardio", sets: [{ set_number: 1, set_kind: "working", cardio }] }],
});

const ran = (min: number, extra: Record<string, unknown> = {}) => ({
  modality: "running", style: "LISS", duration_min: min, ...extra,
});

/** 유산소를 놓을 자리가 있는 최소 드래프트 — 하루만 근력이라 나머지는 휴식일이다. */
const DRAFT = {
  schema_version: "1.0",
  split_type: "full_body",
  week: [{
    day_index: 0, session_type: "lift", focus: "전신",
    items: [{ kind: "strength", exercise_id: "barbell_squat", role: "primary", order: 1, rep_intent: "hypertrophy" }],
  }],
};

function expand(priorLogs: unknown[], draft: unknown = DRAFT, prof = profile()) {
  return expandDraftToWeeklyPlan({
    draft, profile: prof, userId: "u1", weekStartDate: "2026-08-24", weekNumber: 2,
    priorLogs, disclaimer: MEDICAL_DISCLAIMER,
  });
}

/** 확장 결과에서 유산소 줄을 모은다. */
const cardioLines = (plan: { week: Array<{ exercises: Array<Record<string, unknown>> }> }) =>
  plan.week.flatMap((d) => d.exercises.filter((e) => e.modality === "cardio"));

const lineFor = (plan: Parameters<typeof cardioLines>[0], exerciseId: string) =>
  cardioLines(plan).find((e) => e.exercise_id === exerciseId);

describe("지난 기록 → 목표 (T6-1·T6-2·T6-5)", () => {
  it("T6-1 직전 주 같은 운동 기록이 그대로 목표가 된다", () => {
    const { plan } = expand([session(0, "2026-08-17", RUN, ran(45, { distance_m: 5200, incline_pct: 3 }))]);
    const line = lineFor(plan, RUN);
    expect(line).toBeDefined();
    expect(line!.cardio_detail).toMatchObject({ duration_min: 45, distance_m: 5200, incline_pct: 3, style: "LISS" });
    expect(checkWeeklyPlan(plan).ok).toBe(true);
  });

  it("T6-2 같은 주에 두 번이면 가장 최근 날짜", () => {
    const logs = [
      session(0, "2026-08-17", RUN, ran(30)),
      session(3, "2026-08-20", RUN, ran(50)),
    ];
    expect(cardioTargetFromPriorLogs(RUN, logs)?.duration_min).toBe(50);
    // 배열 순서가 뒤집혀도 날짜가 이긴다 — 호출 층의 정렬을 믿지 않는다.
    expect(cardioTargetFromPriorLogs(RUN, [...logs].reverse())?.duration_min).toBe(50);
  });

  it("T6-2 날짜가 없는 옛 문서는 요일로 줄 세운다", () => {
    const noDate = (day: number, min: number, extra: Record<string, unknown> = {}) => ({ ...session(day, "", RUN, ran(min, extra)), date: undefined });
    expect(cardioTargetFromPriorLogs(RUN, [noDate(4, 55), noDate(1, 20)])?.duration_min).toBe(55);
    // D77 — 0분 N초 기록을 목표로 되돌리면 1분 하한으로 올리고 초는 싣지 않는다(목표 스키마 minimum 1).
    const short = cardioTargetFromPriorLogs(RUN, [noDate(2, 0, { duration_sec: 30 })]);
    expect(short?.duration_min).toBe(1);
    expect(short && "duration_sec" in short).toBe(false);
  });

  it("T6-5 기록이 없거나 다른 운동이면 목표가 없다 — 분류로 맞추지 않는다", () => {
    expect(cardioTargetFromPriorLogs(RUN, [])).toBeUndefined();
    // 스테어마스터와 스텝밀은 분류가 둘 다 `stairs` 다. 분류로 맞추면 남의 기록이 목표가 된다.
    const stair = [session(0, "2026-08-17", "stairmaster", { modality: "stairs", style: "LISS", duration_min: 40, level: 9 })];
    expect(cardioTargetFromPriorLogs("step_mill", stair)).toBeUndefined();
    expect(cardioTargetFromPriorLogs("stairmaster", stair)?.level).toBe(9);
  });

  it("T6-5 기록이 없으면 도스표가 정한 분이 그대로 남는다", () => {
    const { plan } = expand([]);
    const lines = cardioLines(plan);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.cardio_detail).toMatchObject({ duration_min: expect.any(Number) });
    // 목표 칸은 아예 없다 — 복사한 게 없으니 붙을 것도 없다.
    for (const line of lines) expect(line.cardio_detail).not.toHaveProperty("distance_m");
  });

  it("옛 기록(방식 칸 없음)은 기본으로 읽는다", () => {
    const old = [session(0, "2026-08-17", RUN, { modality: "running", duration_min: 25 })];
    expect(cardioTargetFromPriorLogs(RUN, old)).toMatchObject({ style: "LISS", duration_min: 25 });
  });
});

describe("복사는 강등·절삭하지 않는다 (T6-3·T6-4 · A11)", () => {
  /** 무거운 하체일 하나 + 나머지 휴식. 하체일에 유산소가 오면 `separate_session` 표시가 붙는다. */
  const HEAVY = {
    schema_version: "1.0",
    split_type: "full_body",
    week: [{
      day_index: 0, session_type: "lift", focus: "하체",
      items: [
        { kind: "strength", exercise_id: "barbell_squat", role: "primary", order: 1, rep_intent: "strength" },
        { kind: "strength", exercise_id: "barbell_deadlift", role: "primary", order: 2, rep_intent: "strength" },
      ],
    }],
  };

  it("T6-3 하체일에 와도 인터벌이 기본으로 바뀌지 않는다 — 배치 표시만 붙는다", () => {
    const segments = [{ label: "질주", sec: 60, speed_kmh: 12 }, { label: "회복", sec: 90, speed_kmh: 5.5 }];
    const logs = [session(0, "2026-08-17", RUN, ran(20, { style: "HIIT", segments }))];
    const { plan } = expand(logs, HEAVY);
    const line = lineFor(plan, RUN);
    expect(line).toBeDefined();
    expect(line!.cardio_detail).toMatchObject({ style: "HIIT", duration_min: 20, segments });
    expect(checkWeeklyPlan(plan).ok).toBe(true);
  });

  it("T6-4 주 상한을 넘는 인터벌도 잘리지 않는다", () => {
    // 서로 다른 세 운동을 각기 다른 날에 인터벌로 했다 — 복사가 `hiitMaxPerWeek` 를 타면 셋 중 일부가 기본이 된다.
    const ids = [RUN, "bicycling_stationary", "rowing_stationary"];
    const logs = ids.map((id, i) => session(i, `2026-08-1${7 + i}`, id, { modality: "running", style: "HIIT", duration_min: 15 + i }));
    for (const [i, id] of ids.entries()) {
      expect(cardioTargetFromPriorLogs(id, logs)).toMatchObject({ style: "HIIT", duration_min: 15 + i });
    }
  });
});

describe("오버라이드·재확장 (T6-6)", () => {
  const LOGS = [session(0, "2026-08-17", RUN, ran(45, { distance_m: 5200 }))];
  /** 사용자가 그 날 유산소에 목표를 직접 넣은 드래프트(041 N4 `cardio` op 가 남기는 모양). */
  const withOverride = {
    ...DRAFT,
    week: [{
      ...DRAFT.week[0],
      cardio_override: { exercise_id: RUN, target: { style: "LISS", duration_min: 25, distance_m: 3000 } },
    }],
  };

  it("사용자가 넣은 목표가 복사값을 이긴다", () => {
    const { plan } = expand(LOGS, withOverride);
    expect(lineFor(plan, RUN)!.cardio_detail).toMatchObject({ duration_min: 25, distance_m: 3000 });
  });

  it("목표 없는 오버라이드(운동만 바꿈)에는 그 운동의 지난 기록이 들어온다", () => {
    const pickOnly = { ...DRAFT, week: [{ ...DRAFT.week[0], cardio_override: { exercise_id: RUN } }] };
    expect(lineFor(expand(LOGS, pickOnly).plan, RUN)!.cardio_detail).toMatchObject({ duration_min: 45, distance_m: 5200 });
  });

  it("재확장은 같은 입력에서 같은 결과다 — 이번 주 기록을 읽지 않는다", () => {
    const a = expand(LOGS).plan;
    const b = expand(LOGS).plan;
    expect(cardioLines(b).map((e) => e.cardio_detail)).toEqual(cardioLines(a).map((e) => e.cardio_detail));
  });
});

describe("종목 이력 previous_cardio (T6-7·T6-8·T6-9)", () => {
  const week = (start: string, sessions: Record<string, unknown>): SavedWeek =>
    ({ week_start_date: start, sessions } as unknown as SavedWeek);

  it("T6-7 유산소만 한 종목도 이력이 있다 — previous 는 null 이다", () => {
    const weeks = [week("2026-08-17", { 0: session(0, "2026-08-17", RUN, ran(45, { distance_m: 5200 })) })];
    const out = exerciseHistory(weeks, RUN, 26, "2026-08-24");
    expect(out.previous).toBeNull();
    expect(out.best).toBeNull();
    expect(out.previous_cardio).toEqual({ week_start_date: "2026-08-17", cardio: ran(45, { distance_m: 5200 }) });
  });

  it("T6-7 같은 주에 두 번이면 요일이 늦은 쪽", () => {
    const weeks = [week("2026-08-17", {
      0: session(0, "2026-08-17", RUN, ran(30)),
      3: session(3, "2026-08-20", RUN, ran(50)),
    })];
    expect(exerciseHistory(weeks, RUN, 26, "2026-08-24").previous_cardio?.cardio).toMatchObject({ duration_min: 50 });
  });

  it("T6-8 이번 주는 뺀다 — 방금 한 값이 「지난 기록」이 되지 않는다", () => {
    const weeks = [week("2026-08-24", { 0: session(0, "2026-08-24", RUN, ran(45)) })];
    expect(exerciseHistory(weeks, RUN, 26, "2026-08-24").previous_cardio).toBeUndefined();
    // 이번 주를 안 주면(주 시작일 없음) 아무것도 빼지 않는다 — §2.6.1 규칙 그대로.
    expect(exerciseHistory(weeks, RUN, 26, "").previous_cardio?.cardio).toMatchObject({ duration_min: 45 });
  });

  it("T6-8 여러 주면 마지막으로 한 주 — 최신순 정렬을 호출 층에 맡기지 않는다", () => {
    const weeks = [
      week("2026-08-03", { 0: session(0, "2026-08-03", RUN, ran(20)) }),
      week("2026-08-17", { 0: session(0, "2026-08-17", RUN, ran(45)) }),
    ];
    expect(exerciseHistory(weeks, RUN, 26, "2026-08-24").previous_cardio?.cardio).toMatchObject({ duration_min: 45 });
  });

  it("T6-9 근력 종목의 응답에는 키 자체가 없다", () => {
    const lift = {
      session_id: "s-0", day_index: 0, date: "2026-08-17", completion: "completed",
      exercises: [{ exercise_id: "barbell_squat", sets: [{ set_number: 1, set_kind: "working", actual_reps: 8, actual_load_kg: 60 }] }],
    };
    const out = exerciseHistory([week("2026-08-17", { 0: lift })], "barbell_squat", 26, "2026-08-24");
    expect(out.previous).toMatchObject({ top_load_kg: 60, top_reps: 8 });
    expect("previous_cardio" in out).toBe(false);
  });
});
