/**
 * 하드 지표 — 코드가 자동 판정하는 층(백로그 운동목록_및_운동플랜_개선/09 §5 2 · 기준표 10 §1).
 * 테스트 전용이다. 운영 경로는 이 파일을 읽지 않는다.
 */
import { patternOf } from "../../src/generation/slots";
import { allowedByTools, byId, ownedTools } from "../../src/data/exercises";
import { contraindicatedMuscles } from "../../src/generation/contraindications";
import { checkPlanRules } from "../../src/generation/plan-rules";
import { checkWeeklyPlan } from "../../src/schemas/validate";
import type { UserProfile } from "../../src/generation/types";

/**
 * 기본 운동 — 헬스장 입문 기본 세트(백로그 03 §3 1 · u116 이 고친 구성), 그 「덤벨 운동」의 대표 동작,
 * 맨몸 기본(02 §3 6). 덤벨을 통째로 넣지 않는 이유: 01 §2.2 가 비대표 예로 든 「클로즈 그립 덤벨 프레스」가 섞인다.
 * **초안이다** — 기준표 10 §1 과 함께 사용자가 검토한다(U2).
 */
export const BASIC_EXERCISE_IDS: ReadonlySet<string> = new Set([
  "leg_press",
  "wide_grip_lat_pulldown",
  "seated_cable_rows",
  "leverage_chest_press",
  "machine_bench_press",
  "machine_shoulder_military_press",
  "lying_leg_curls",
  "seated_leg_curl",
  "leg_extensions",
  "thigh_adductor",
  "thigh_abductor",
  "goblet_squat",
  "dumbbell_bench_press",
  "one_arm_dumbbell_row",
  "dumbbell_shoulder_press",
  "dumbbell_lunges",
  "pushups",
  "plank",
  "crunches",
  "bodyweight_squat",
  "bodyweight_lunge",
  "butt_lift_bridge",
]);

const PUSH_MUSCLES = new Set(["chest", "shoulders", "triceps"]);
const PULL_MUSCLES = new Set(["lats", "middle back", "biceps"]);

export interface PlanMetrics {
  schemaOk: boolean;
  ruleProblems: string[];
  /** 보유 도구로 못 하는 운동(`requires`) — 등장마다 1. */
  toolViolations: string[];
  /** 부상 부위를 쓰는 운동 — 등장마다 1. */
  contraindicationViolations: string[];
  /** 근육별 주간 워킹 세트 — 주근육 1, 보조근육 0.5. */
  setsByMuscle: Record<string, number>;
  pushSets: number;
  pullSets: number;
  /** 밀기 ÷ 당기기. 당기기 0 이면 null. */
  pushPullRatio: number | null;
  /** 근력·맨몸 운동 줄 중 기본 운동 비율(0–1). */
  basicRatio: number;
  exerciseCount: number;
}

interface PlanShape {
  week?: Array<{ exercises?: Array<{ exercise_id?: string; modality?: string; sets?: Array<{ set_kind?: string }> }> }>;
}

export function evaluatePlan(plan: unknown, profile: UserProfile): PlanMetrics {
  const owned = ownedTools(profile);
  const injured = new Set(contraindicatedMuscles(profile).muscles);
  const metrics: PlanMetrics = {
    schemaOk: checkWeeklyPlan(plan).ok,
    ruleProblems: checkPlanRules(plan, profile.days_per_week),
    toolViolations: [],
    contraindicationViolations: [],
    setsByMuscle: {},
    pushSets: 0,
    pullSets: 0,
    pushPullRatio: null,
    basicRatio: 0,
    exerciseCount: 0,
  };
  let basic = 0;
  for (const day of (plan as PlanShape)?.week ?? []) {
    for (const row of day.exercises ?? []) {
      const exercise = typeof row.exercise_id === "string" ? byId(row.exercise_id) : undefined;
      if (!exercise) continue;
      // 안전 지표는 유산소 줄도 본다(codex N3 R1). 볼륨·비율은 근력 줄만.
      if (!allowedByTools(exercise, owned)) metrics.toolViolations.push(exercise.id);
      if (exercise.contraindication_tags.some((m) => injured.has(m))) metrics.contraindicationViolations.push(exercise.id);
      if (row.modality === "cardio") continue;
      metrics.exerciseCount += 1;
      if (BASIC_EXERCISE_IDS.has(exercise.id)) basic += 1;
      const sets = (row.sets ?? []).filter((s) => s.set_kind === "working").length;
      const add = (muscle: string, n: number) => {
        metrics.setsByMuscle[muscle] = (metrics.setsByMuscle[muscle] ?? 0) + n;
      };
      for (const m of exercise.primary_muscles) add(m, sets);
      for (const m of exercise.secondary_muscles) add(m, sets * 0.5);
      // 어깨는 움직임 패턴으로 가른다(12 §1 ④ 「당기기 ≥ 밀기」) — 후면 어깨(페이스풀·리버스 플라이)는 당기기, 측면 레이즈는
      // 밀기도 당기기도 아니다(카탈로그 force 가 종목마다 제각각이라 방향값으로 가르면 측면 레이즈가 당기기가 된다 — N9).
      const shoulderPattern = exercise.primary_muscles.includes("shoulders") ? patternOf(exercise) : null;
      // 패턴을 모르는 어깨 종목(reverse_machine_flyes 등)은 방향값으로 — 당기기면 당기기(codex N9 R1).
      const shoulderPull = shoulderPattern === "rear_delt" || (shoulderPattern === null && exercise.primary_muscles.includes("shoulders") && exercise.force === "pull");
      const sideRaise = shoulderPattern === "lat_raise";
      if (!shoulderPull && !sideRaise && exercise.primary_muscles.some((m) => PUSH_MUSCLES.has(m))) metrics.pushSets += sets;
      if (shoulderPull || exercise.primary_muscles.some((m) => PULL_MUSCLES.has(m))) metrics.pullSets += sets;
    }
  }
  metrics.pushPullRatio = metrics.pullSets === 0 ? null : metrics.pushSets / metrics.pullSets;
  metrics.basicRatio = metrics.exerciseCount === 0 ? 0 : basic / metrics.exerciseCount;
  return metrics;
}
