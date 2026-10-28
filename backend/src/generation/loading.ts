/**
 * Load prescription and double progression — code-owned numbers (INV-1).
 *
 * This is the one place the *numeric* prior log is used. The LLM never sees these
 * values (see `prompt.ts`); the expansion engine gets them in full.
 *
 * Grounding: docs/research/03-ai-plan-generation.md (Epley e1RM, NSCA rep/%1RM
 * continuum, double progression) and design §3.2 / §3.2.1.
 */
import {
  BEGINNER_WORKING_REP_RANGE,
  ROLE_REP_RANGES,
  BODYWEIGHT_LADDERS,
  PAIN_DELOAD_FACTOR,
  WORKING_REP_RANGE,
  incrementForMuscles,
  loadFloorFor,
  loadStepFor,
  startLoadFor,
  type ExperienceLevel,
} from "../data/constants";
import type { Exercise } from "../data/exercises";
import type { Goal } from "./types";
import { hasHistoryGap, priorPerformedDate } from "./prior-history";

/**
 * 무게를 **올리는** 목표. 나머지 목표는 무게를 유지하고 렙만 범위 안에서 오르게 둔다.
 *
 * 근거: ACSM 2026 저항운동 가이드라인은 목표별로 처방을 나눈다 — 근력은 ~80% 1RM,
 * 근비대는 주당 근육군당 ~10세트인 반면, **일반 건강·장수는 "주 2회 전 주요 근육군"
 * 이면 충분하고 실패 지점 훈련·주기화·점증 부하는 선택**이라고 명시한다
 * (137개 체계적 고찰 종합, 2026). 즉 증량 로직을 전 목표에 거는 것은 근거가 없다.
 *
 * **감량·교체는 여기서 게이팅하지 않는다** — 통증·실패로 인한 감량은 목표가
 * 무엇이든 항상 적용되는 안전 규칙이다(INV-6).
 */
const PROGRESSIVE_OVERLOAD_GOALS: readonly Goal[] = ["build_muscle", "gain_strength"];

/** 이 목표 조합에서 무게를 올려도 되는가. 하나라도 해당하면 올린다. */
export function allowsLoadIncrease(goals: readonly Goal[]): boolean {
  return goals.some((g) => PROGRESSIVE_OVERLOAD_GOALS.includes(g));
}

/**
 * NSCA continuum (research/03): reps → %1RM. Interpolated between anchors.
 * `[15, 65]` 는 D55 ① 이 더한 앵커(NSCA 부하표 연장 · ACSM 초보 50–70% 안) —
 * 이것이 없으면 12렙 이상이 전부 67% 라 입문자 렙 범위 10–15 가 무게를 1g 도
 * 안 내린다(040 그래프 §1 ③).
 */
const REP_PCT_ANCHORS: ReadonlyArray<[reps: number, pct: number]> = [
  [1, 100],
  [4, 90],
  [6, 85],
  [8, 80],
  [10, 75],
  [12, 67],
  [15, 65],
];

/** Barbell plate reality: prescriptions land on 2.5 kg steps. */
const LOAD_STEP_KG = 2.5;

/** Rest between working sets (research/03: hypertrophy 1–3 min). */
export const REST_SECONDS = { compound: 150, isolation: 90 } as const;

/** Epley: 1RM = load × (1 + reps/30). Undefined for a non-positive set. */
export function estimateE1rm(reps: number, loadKg: number): number | undefined {
  if (!Number.isFinite(reps) || !Number.isFinite(loadKg)) return undefined;
  if (reps <= 0 || loadKg <= 0) return undefined;
  return loadKg * (1 + reps / 30);
}

/** %1RM for a rep target, linearly interpolated across the NSCA anchors. */
export function pctOf1rm(reps: number): number {
  const first = REP_PCT_ANCHORS[0];
  const last = REP_PCT_ANCHORS[REP_PCT_ANCHORS.length - 1];
  if (reps <= first[0]) return first[1];
  if (reps >= last[0]) return last[1];

  for (let i = 1; i < REP_PCT_ANCHORS.length; i += 1) {
    const [highReps, highPct] = REP_PCT_ANCHORS[i - 1];
    const [lowReps, lowPct] = REP_PCT_ANCHORS[i];
    if (reps <= lowReps) {
      const span = lowReps - highReps;
      return highPct + ((lowPct - highPct) * (reps - highReps)) / span;
    }
  }
  return last[1];
}

export function roundToPlate(kg: number, step = LOAD_STEP_KG): number {
  return Math.max(step, Math.round(kg / step) * step);
}

/**
 * `from ± delta` 를 격자에 맞춘다 — 단 **`from` 이 이미 격자 밖이면 그대로 더한다.**
 * 사용자가 적은 7.5kg 덤벨에 +2 를 하면 9.5 가 실재하는 덤벨이고, 1kg 격자로
 * 반올림하면 10(+2.5)이 돼 D55 ① 의 「정확히 +2kg」이 깨진다(codex R1 #3).
 */
function stepFrom(from: number, delta: number, step: number): number {
  const onGrid = Math.abs(from / step - Math.round(from / step)) < 1e-9;
  return onGrid ? Math.round((from + delta) / step) * step : from + delta;
}

/**
 * Rounds **down** to a plate step. Used on the decrease paths: nearest-rounding
 * can round a light load up, which would turn "decrease" into an increase.
 * Returns undefined when there is no lighter step left.
 */
export function roundDownToPlate(kg: number, step = LOAD_STEP_KG, floor = step): number | undefined {
  const stepped = Math.floor(kg / step) * step;
  return stepped >= floor ? stepped : undefined;
}

// ── Prior-log reading ────────────────────────────────────────────────────────

export interface PriorSet {
  reps: number;
  loadKg: number;
  failed: boolean;
  painFlag: boolean;
  /** Progression is judged on working sets only (S-GEN-10). */
  setKind: "warmup" | "working";
}

/**
 * Strength sets logged for one exercise last week. Cardio sets are skipped:
 * they carry no load. Malformed entries are dropped — `prior_logs` is
 * `unknown[]` on the wire.
 */
export function priorSetsFor(exerciseId: string, priorLogs: unknown[]): PriorSet[] {
  const out: PriorSet[] = [];
  for (const rawSession of priorLogs ?? []) {
    const session = rawSession as { exercises?: unknown } | null;
    if (!session || typeof session !== "object") continue;
    const exercises = Array.isArray(session.exercises) ? session.exercises : [];
    for (const rawExercise of exercises) {
      const exercise = rawExercise as { exercise_id?: unknown; sets?: unknown } | null;
      if (!exercise || exercise.exercise_id !== exerciseId) continue;
      const sets = Array.isArray(exercise.sets) ? exercise.sets : [];
      for (const rawSet of sets) {
        const set = rawSet as Record<string, unknown> | null;
        if (!set || typeof set !== "object" || set.cardio) continue;
        const reps = typeof set.actual_reps === "number" ? set.actual_reps : undefined;
        const loadKg = typeof set.actual_load_kg === "number" ? set.actual_load_kg : undefined;
        if (reps === undefined || loadKg === undefined) continue;
        out.push({
          reps,
          loadKg,
          failed: set.failed === true,
          painFlag: set.pain_flag === true,
          // Older logs written before `set_kind` became required read as working
          // sets — the safe reading, since a mislabelled warmup only blocks an
          // increase, it never causes one.
          setKind: set.set_kind === "warmup" ? "warmup" : "working",
        });
      }
    }
  }
  return out;
}

/** Best estimated 1RM across the logged sets, or undefined with no usable set. */
export function bestE1rm(sets: PriorSet[]): number | undefined {
  let best: number | undefined;
  for (const set of sets) {
    const estimate = estimateE1rm(set.reps, set.loadKg);
    if (estimate !== undefined && (best === undefined || estimate > best)) best = estimate;
  }
  return best;
}

// ── Progression (S-GEN-9/10/11) ──────────────────────────────────────────────

export type ProgressionDecisionKind = "increase" | "hold" | "decrease" | "substitute";
export type ProgressionReason =
  | "hit_top_reps"
  | "reps_in_progress"
  | "missed_reps"
  | "pain_flag"
  | "first_week"
  | "user_edit"
  | "history_gap"
  /** 렙 상단을 채웠지만 목표가 증량형이 아니라 무게를 유지했다. */
  | "goal_no_overload";

export interface ProgressionDecision {
  decision: ProgressionDecisionKind;
  reason_code: ProgressionReason;
  from_load_kg: number | null;
  to_load_kg: number | null;
  source_date?: string;
}

export interface LoadPrescription {
  /** null on week 1: no history and no population data to seed from. */
  targetLoadKg: number | null;
  targetLoadPct1rm: number | null;
  repsLow: number;
  repsHigh: number;
  restSeconds: number;
  /** null on week 1 — the contract calls this "2주차+" (02-data-model §B2). */
  progression: ProgressionDecision | null;
}

/** Heaviest load actually used last week — the base a decision moves from. */
function topLoad(sets: PriorSet[]): number | undefined {
  let top: number | undefined;
  for (const set of sets) {
    if (top === undefined || set.loadKg > top) top = set.loadKg;
  }
  return top;
}

/**
 * Double progression (S-GEN-10/11), judged on **working sets only** — a warmup
 * set is light by design, and counting it would block every increase:
 *  - pain logged            → decrease by PAIN_DELOAD_FACTOR (research/03 ≈ −10%)
 *  - any failed set         → decrease one increment step
 *  - every set at reps_high → increase one increment step (증량형 목표일 때만;
 *                             아니면 hold/`goal_no_overload`)
 *  - otherwise              → hold and let reps climb inside the range
 *
 * When the load cannot go lower (already at the lightest plate step) the decision
 * becomes `substitute`: S-GEN-11 says lower *or* substitute, and claiming a
 * decrease we cannot deliver would be a lie in the artifact.
 *
 * The prior log carries actuals but not last week's *targets*, so `repsHigh`
 * comes from this engine's own rep range — the same engine wrote last week's
 * plan, so the target it used is the same constant.
 */
export function decideProgression(
  exercise: Exercise,
  sets: PriorSet[],
  repsHigh: number,
  allowIncrease = true,
  level?: ExperienceLevel,
  repsLow = 0,
  historyGap = false,
): ProgressionDecision | null {
  const working = sets.filter((set) => set.setKind === "working");
  if (working.length === 0) return null; // week 1, or only warmups logged

  const from = topLoad(working) ?? null;
  // 맨몸은 kg 을 움직이지 않는다(백로그 02 §3 3) — 0kg 기록에 +2.5kg 증량, 렙 미달에 「더 낮출
  // 무게 없음 → 교체」가 붙던 자리. 단계 이동은 `nextBodyweightStep` 이 운동을 바꿔서 한다.
  // 통증은 종전대로 교체 권고다(INV-6) — 낮출 kg 이 없다.
  if (exercise.modality === "bodyweight") {
    if (working.some((set) => set.painFlag)) {
      return { decision: "substitute", reason_code: "pain_flag", from_load_kg: null, to_load_kg: null };
    }
    const reason: ProgressionReason = bodyweightMissed(working, repsLow)
      ? "missed_reps"
      : historyGap ? "history_gap" : working.every((set) => set.reps >= repsHigh)
        ? "hit_top_reps"
        : "reps_in_progress";
    // kg 은 싣지 않는다 — 예전 기록에 남은 무게(2.5kg 등)가 다음 주 처방으로 옮겨 가면 안 된다(codex N2 R1).
    return { decision: "hold", reason_code: reason, from_load_kg: null, to_load_kg: null };
  }
  // 증량과 격자는 한 쌍이다(D55 ①) — 격자가 증량보다 굵으면 반올림이 증량을 삼킨다.
  const increment = incrementForMuscles(exercise.primary_muscles, exercise.equipment, level);
  const step = loadStepFor(exercise.primary_muscles, exercise.equipment, level);
  // 장비 하한(빈 바 20kg) 아래로는 내리지 않는다 — 없는 무게를 처방하느니 교체(D55 ②).
  const floor = loadFloorFor(exercise.equipment, step);

  const decrease = (reason: ProgressionReason, target: number | null): ProgressionDecision => {
    let to: number | undefined;
    if (target !== null && from !== null) {
      // 렙 실패 = 정확히 −증량(격자 밖 무게도 그대로 — `stepFrom`). 통증 = −10% 를 격자로 내림.
      to = reason === "missed_reps" ? stepFrom(from, -increment, step) : roundDownToPlate(target, step, floor);
      if (to !== undefined && to < floor) to = undefined;
    }
    if (from !== null && (to === undefined || to >= from)) {
      // Nothing lighter to prescribe — swap the exercise instead of pretending.
      return { decision: "substitute", reason_code: reason, from_load_kg: from, to_load_kg: null };
    }
    return { decision: "decrease", reason_code: reason, from_load_kg: from, to_load_kg: to ?? null };
  };

  if (working.some((set) => set.painFlag)) {
    return decrease("pain_flag", from === null ? null : from * PAIN_DELOAD_FACTOR);
  }
  if (working.some((set) => set.failed)) {
    return decrease("missed_reps", from === null ? null : from - increment);
  }
  if (historyGap) {
    return { decision: "hold", reason_code: "history_gap", from_load_kg: from, to_load_kg: from };
  }
  if (working.every((set) => set.reps >= repsHigh)) {
    // 목표가 증량형이 아니면 올리지 않는다 — 상단을 채웠어도 유지가 처방이다.
    if (!allowIncrease) {
      return { decision: "hold", reason_code: "goal_no_overload", from_load_kg: from, to_load_kg: from };
    }
    return {
      decision: "increase",
      reason_code: "hit_top_reps",
      from_load_kg: from,
      to_load_kg: from === null ? null : Math.max(step, stepFrom(from, increment, step)),
    };
  }
  return { decision: "hold", reason_code: "reps_in_progress", from_load_kg: from, to_load_kg: from };
}

function bodyweightMissed(working: PriorSet[], repsLow: number): boolean {
  return working.some((set) => set.failed || set.reps < repsLow);
}

export interface BodyweightStep {
  kind: "hold" | "ladder_up" | "ladder_down";
  exerciseId: string;
}

/**
 * 맨몸 다음 주 운동(백로그 02 §3 3): 모든 워킹 세트가 렙 상단 → 사다리 한 칸 위, 실패·하단 미달 →
 * 한 칸 아래(교체 아님), 그 밖·통증·사다리 밖 → 그대로. `allowed` 가 거르는 칸(보유 도구 밖)은 건너뛴다.
 * 끝 칸에서는 hold 다.
 */
export function nextBodyweightStep(
  exerciseId: string,
  sets: PriorSet[],
  repsLow: number,
  repsHigh: number,
  allowed: (id: string) => boolean = () => true,
  ladders: readonly (readonly string[])[] = BODYWEIGHT_LADDERS,
  allowAdvance = true,
): BodyweightStep {
  const hold: BodyweightStep = { kind: "hold", exerciseId };
  const working = sets.filter((set) => set.setKind === "working");
  const ladder = ladders.find((rungs) => rungs.includes(exerciseId));
  if (!ladder || working.length === 0 || working.some((set) => set.painFlag)) return hold;
  const missed = bodyweightMissed(working, repsLow);
  if (!missed && !allowAdvance) return hold;
  if (!missed && !working.every((set) => set.reps >= repsHigh)) return hold;
  const dir = missed ? -1 : 1;
  for (let i = ladder.indexOf(exerciseId) + dir; i >= 0 && i < ladder.length; i += dir) {
    if (allowed(ladder[i])) return { kind: missed ? "ladder_down" : "ladder_up", exerciseId: ladder[i] };
  }
  return hold;
}

/**
 * Full load prescription for one exercise.
 *
 * **Week 1 deliberately prescribes no weight.** There is no history and this repo
 * has no population-load dataset, so any number would be invented — the schema
 * allows `target_load_kg: null` and the app tells the user to find a load they
 * can move for the rep range. Week 2+ works from the logged e1RM.
 */
export function prescribeLoad(
  exercise: Exercise,
  priorLogs: unknown[],
  repIntent: "strength" | "hypertrophy" | "endurance" = "hypertrophy",
  allowIncrease = true,
  level?: ExperienceLevel,
  targetWeek?: string,
): LoadPrescription {
  const sets = priorSetsFor(exercise.id, priorLogs);
  const working = sets.filter((set) => set.setKind === "working");
  const { min: repsLow, max: repsHigh } = repRangeFor(repIntent, level, exercise.mechanic);
  const progression = decideProgression(exercise, sets, repsHigh, allowIncrease, level, repsLow,
    hasHistoryGap(exercise.id, priorLogs, targetWeek));
  const sourceDate = priorPerformedDate(exercise.id, priorLogs);
  if (progression && targetWeek && sourceDate) progression.source_date = sourceDate;
  const step = loadStepFor(exercise.primary_muscles, exercise.equipment, level);
  const restSeconds = exercise.mechanic === "compound" ? REST_SECONDS.compound : REST_SECONDS.isolation;

  // A decision that moves the load owns the number; otherwise fall back to the
  // e1RM-derived target, and to null when there is no history at all.
  // `substitute` deliberately carries no load — B4 picks the replacement lift.
  const decided = progression?.to_load_kg ?? null;
  const e1rm = bestE1rm(working);
  const pct = pctOf1rm(repsHigh);
  const derived = e1rm === undefined ? null : roundToPlate((e1rm * pct) / 100, step);
  // 이력이 없는 입문자만 장비별 시작값(D55 ②). 이력이 있으면 기록이 이긴다 — 2주차가
  // 빈 바로 되돌아가면 안 된다. 초중급·표 밖 장비는 종전대로 null.
  const seeded = working.length === 0 ? startLoadFor(exercise, level) : null;
  // 맨몸은 kg 을 처방하지 않는다(백로그 02 §3 3) — 기록에 무게가 남아 있어도 e1RM 으로 되살리지 않는다.
  const targetLoadKg = exercise.modality === "bodyweight" ? null : (decided ?? derived ?? seeded);

  return {
    targetLoadKg,
    targetLoadPct1rm: targetLoadKg === null || e1rm === undefined ? null : round1((targetLoadKg / e1rm) * 100),
    repsLow,
    repsHigh,
    restSeconds,
    progression,
  };
}

/**
 * Rep range per intent. Hypertrophy is the Phase 1 default (design §3.2.1).
 * 근비대는 경험 × 종목 역할(복합/고립)로 정한다(D104 ② · `ROLE_REP_RANGES`). 역할이 없는 종목은
 * 경험별 한 줄(입문자 10–15 · 초중급 8–12 — D55 ①). strength·endurance 는 경험 무관하다 — 입문자에게
 * strength 를 주지 않는 것은 생성 쪽(`resolveDraft`)이 막는다. 사용자가 편집에서 고르면 그대로 받는다.
 */
export function repRangeFor(
  repIntent: "strength" | "hypertrophy" | "endurance",
  level?: ExperienceLevel,
  mechanic?: "compound" | "isolation" | null,
): {
  min: number;
  max: number;
} {
  switch (repIntent) {
    case "strength":
      return { min: 3, max: 5 };
    case "endurance":
      return { min: 12, max: 15 };
    default: {
      const range = mechanic
        ? ROLE_REP_RANGES[level === "beginner" ? "beginner" : "novice_intermediate"][mechanic]
        : level === "beginner"
          ? BEGINNER_WORKING_REP_RANGE
          : WORKING_REP_RANGE;
      return { min: range.min, max: range.max };
    }
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
