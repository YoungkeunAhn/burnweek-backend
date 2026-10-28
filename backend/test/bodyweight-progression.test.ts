import { describe, expect, it } from "vitest";
import { decideProgression, nextBodyweightStep, prescribeLoad, priorSetsFor } from "../src/generation/loading";
import { expandDraftToWeeklyPlan } from "../src/generation/expand";
import { applyEdit } from "../src/generation/edit";
import { allowedGeneratedExerciseIds } from "../src/generation/exercise-policy";
import { checkWeeklyPlan } from "../src/schemas/validate";
import { MEDICAL_DISCLAIMER } from "../src/generation/safety";
import { byId } from "../src/data/exercises";
import type { UserProfile } from "../src/generation/types";

// 맨몸 진행(백로그 운동목록_및_운동플랜_개선/02 §3 3 · 실행 그래프 N2).

const PUSHUP = byId("pushups")!;

function logs(exerciseId: string, sets: Array<{ reps: number; kg?: number; failed?: boolean; pain?: boolean }>) {
  return [
    {
      schema_version: "1.0",
      session_id: "s1",
      plan_id: "p1",
      date: "2026-10-05",
      day_index: 0,
      completion: "completed",
      exercises: [
        {
          exercise_id: exerciseId,
          modality: "bodyweight",
          sets: sets.map((set, i) => ({
            set_number: i + 1,
            set_kind: "working",
            actual_reps: set.reps,
            actual_load_kg: set.kg ?? 0,
            ...(set.failed ? { failed: true } : {}),
            ...(set.pain ? { pain_flag: true } : {}),
          })),
        },
      ],
    },
  ];
}

const three = (reps: number) => [{ reps }, { reps }, { reps }];

describe("맨몸 진행 판정", () => {
  it("T2-1 상단 미만이면 hold, 무게 진행을 타지 않는다", () => {
    const decision = decideProgression(PUSHUP, priorSetsFor("pushups", logs("pushups", three(10))), 12, true, "beginner", 8);
    expect(decision).toEqual({ decision: "hold", reason_code: "reps_in_progress", from_load_kg: null, to_load_kg: null });
    expect(nextBodyweightStep("pushups", priorSetsFor("pushups", logs("pushups", three(10))), 8, 12).kind).toBe("hold");
  });

  it("T2-2 모든 세트 상단 → 다음 사다리 칸, 끝 칸은 hold", () => {
    const up = nextBodyweightStep("incline_push_up", priorSetsFor("incline_push_up", logs("incline_push_up", three(12))), 8, 12);
    expect(up).toEqual({ kind: "ladder_up", exerciseId: "knee_push_up" });
    const top = "push_ups_with_feet_elevated";
    expect(nextBodyweightStep(top, priorSetsFor(top, logs(top, three(12))), 8, 12)).toEqual({ kind: "hold", exerciseId: top });
    // 도구 밖 칸은 건너뛴다.
    const skip = nextBodyweightStep("wall_push_up", priorSetsFor("wall_push_up", logs("wall_push_up", three(12))), 8, 12, (id) => id !== "incline_push_up");
    expect(skip.exerciseId).toBe("knee_push_up");
  });

  it("T2-3 하단 미달 → 한 칸 아래, substitute 아님", () => {
    const sets = priorSetsFor("pushups", logs("pushups", three(5)));
    expect(nextBodyweightStep("pushups", sets, 8, 12)).toEqual({ kind: "ladder_down", exerciseId: "knee_push_up" });
    const held = { decision: "hold", reason_code: "missed_reps", from_load_kg: null, to_load_kg: null };
    expect(decideProgression(PUSHUP, sets, 12, true, "beginner", 8)).toEqual(held);
    const failed = priorSetsFor("pushups", logs("pushups", [{ reps: 12, failed: true }, { reps: 12 }]));
    expect(decideProgression(PUSHUP, failed, 12, true, "beginner", 8)).toEqual(held);
  });

  it("T2-4 상단을 채워도 kg 을 붙이지 않는다", () => {
    const prescription = prescribeLoad(PUSHUP, logs("pushups", three(15)), "hypertrophy", true, "beginner");
    expect(prescription.progression).toMatchObject({ decision: "hold", reason_code: "hit_top_reps" });
    expect(prescription.targetLoadKg).toBeNull();
    // 예전 기록에 남은 무게도 되살리지 않는다(codex N2 R1).
    const legacy = prescribeLoad(PUSHUP, logs("pushups", [{ reps: 10, kg: 2.5 }]), "hypertrophy", true, "beginner");
    expect(legacy.targetLoadKg).toBeNull();
    expect(legacy.targetLoadPct1rm).toBeNull();
  });

  it("통증은 종전대로 교체 권고(INV-6)", () => {
    const sets = priorSetsFor("pushups", logs("pushups", [{ reps: 10, kg: 10, pain: true }]));
    expect(decideProgression(PUSHUP, sets, 12)).toEqual({ decision: "substitute", reason_code: "pain_flag", from_load_kg: null, to_load_kg: null });
    expect(nextBodyweightStep("pushups", sets, 8, 12).kind).toBe("hold");
  });
});

const BODYWEIGHT: UserProfile = {
  goals: ["lose_fat"],
  experience_level: "beginner",
  days_per_week: 2,
  session_len_min: 45,
  environment: "bodyweight_only",
  equipment: [],
  cardio_pref: "maintain_health",
  cardio_modalities: [],
  injuries: [],
  red_flags: { hard: [], low_risk: [] },
};

function expandWith(firstId: string, priorLogs: unknown[]) {
  const item = (id: string, order: number) => ({ kind: "strength", exercise_id: id, role: "primary", order, rep_intent: "hypertrophy" });
  return expandDraftToWeeklyPlan({
    draft: {
      schema_version: "1.0",
      split_type: "full_body",
      week: [
        { day_index: 0, session_type: "lift", focus: "전신 A", items: [item(firstId, 1), item("bodyweight_squat", 2)] },
        { day_index: 3, session_type: "lift", focus: "전신 B", items: [item("table_inverted_row", 1), item("bodyweight_lunge", 2)] },
      ],
    },
    profile: BODYWEIGHT,
    userId: "u1",
    weekStartDate: "2026-10-12",
    weekNumber: 2,
    priorLogs,
    // AI 생성 경로 — 사다리는 여기서만 돈다(편집 재확장은 이 값을 안 준다).
    allowedGeneratedExerciseIds: allowedGeneratedExerciseIds(BODYWEIGHT, []),
    disclaimer: MEDICAL_DISCLAIMER,
  });
}

/** 편집 재확장 — `edit.ts` 처럼 후보 집합 없이 저장 드래프트를 다시 편다. */
function reexpand(draft: unknown, priorLogs: unknown[]) {
  return expandDraftToWeeklyPlan({
    draft, profile: BODYWEIGHT, userId: "u1", weekStartDate: "2026-10-12", weekNumber: 2, priorLogs, disclaimer: MEDICAL_DISCLAIMER,
  });
}

const ids = (plan: unknown) =>
  (plan as { week: Array<{ exercises: Array<{ exercise_id: string }> }> }).week.flatMap((d) => d.exercises.map((e) => e.exercise_id));

describe("맨몸 사다리 — 확장 배선", () => {
  it("한 주를 건너뛰면 상단 달성도 올리지 않고 실패에 따른 하향은 유지한다", () => {
    const old = (reps: number) => logs("pushups", three(reps)).map((s) => ({ ...s, date: "2026-09-28" }));
    const held = expandWith("pushups", old(15));
    expect(held.problems).toEqual([]);
    expect(checkWeeklyPlan(held.plan).ok).toBe(true);
    expect(ids(held.plan)).toContain("pushups");
    expect(ids(held.plan)).not.toContain("push_ups_with_feet_elevated");
    const exercises = (held.plan as { week: Array<{ exercises: Array<{ exercise_id: string; progression_decision: unknown }> }> }).week.flatMap((d) => d.exercises);
    expect(exercises.find((e) => e.exercise_id === "pushups")?.progression_decision)
      .toMatchObject({ decision: "hold", reason_code: "history_gap", source_date: "2026-09-28" });
    expect(ids(expandWith("pushups", old(3)).plan)).toContain("knee_push_up");
  });
  it("T2-5 상단을 채운 칸은 다음 칸으로 바뀌고 플랜은 스키마·규칙을 통과한다", () => {
    const { plan, warnings, problems } = expandWith("knee_push_up", logs("knee_push_up", three(15)));
    expect(problems).toEqual([]);
    expect(checkWeeklyPlan(plan).ok).toBe(true);
    expect(ids(plan)).toContain("pushups");
    expect(ids(plan)).not.toContain("knee_push_up");
    expect(warnings.some((w) => w.includes("푸시업(으)로 올렸어요"))).toBe(true);
  });

  it("T2-8 저장 드래프트도 옮긴 칸이라 편집이 그 운동을 찾고, 재확장은 같은 결과다", () => {
    const priorLogs = logs("knee_push_up", three(15));
    const first = expandWith("knee_push_up", priorLogs);
    expect(ids(reexpand(first.draft, priorLogs).plan)).toEqual(ids(first.plan));
    // 두 칸을 다 기록했어도 편집 재확장이 한 칸 더 올리지 않는다(codex N2 R2).
    const both = [...logs("knee_push_up", three(15)), ...logs("pushups", three(15))];
    const generated = expandWith("knee_push_up", both);
    expect(ids(reexpand(generated.draft, both).plan)).toEqual(ids(generated.plan));
    const removed = applyEdit(first.draft, { op: "remove", day_index: 0, exercise_id: "pushups" }, first.plan);
    expect("error" in removed).toBe(false);
  });

  it("T2-6 LLM 이 낮은 칸을 골라도 지난주 기록한 칸에서 잇는다", () => {
    const { plan } = expandWith("knee_push_up", logs("pushups", three(10)));
    expect(ids(plan)).toContain("pushups");
  });

  it("T2-7 보유 도구 밖 칸으로는 내려가지 않는다(벽 푸시업 · 도구 없음)", () => {
    const { plan, problems } = expandWith("knee_push_up", logs("knee_push_up", three(4)));
    expect(problems).toEqual([]);
    expect(ids(plan)).toContain("knee_push_up");
    expect(ids(plan)).not.toContain("wall_push_up");
  });
});
