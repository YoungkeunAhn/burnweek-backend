/**
 * Final value validation for WeeklyPlan v1 — the rules the JSON schema cannot
 * express (02-data-model §B2 "코드가 소유하는 추가 검증", S-GEN-3/4/5/6).
 *
 * Separate from the assembly in `expand.ts` on purpose: the pipeline validates
 * whatever it is about to return, and the golden-set tests (B7) run this on plans
 * they did not build.
 */
import { WEEKLY_VOLUME_CAPS } from "../data/constants";
import { byId, capGroupsOf } from "../data/exercises";
import { checkWeeklyPlan } from "../schemas/validate";

/**
 * Reason codes each decision is allowed to carry (02-data-model §B2).
 * `first_week` appears in the schema enum but on no decision here: week 1 carries
 * `progression_decision: null`, not a hold.
 */
/** `export` 는 미니앱 `check.mjs` 가 이 표를 그대로 태우기 위해서다(백로그 023 §2 ·
 *  D36) — 화면의 근거 문장 표가 여기서 갈리면 검증기가 먼저 죽는다. */
export const ALLOWED_REASONS: Record<string, string[]> = {
  increase: ["hit_top_reps"],
  // `goal_no_overload`: 렙 상단을 채웠지만 목표가 증량형이 아니라 유지한 경우
  // (`loading.allowsLoadIncrease`). hold 의 사유가 하나뿐이라는 전제가 여기서 깨진다.
  hold: ["reps_in_progress", "goal_no_overload", "history_gap"],
  decrease: ["pain_flag", "missed_reps"],
  substitute: ["pain_flag", "missed_reps", "user_edit"],
};

/** 맨몸 운동만 더 갖는 hold 사유 — kg 을 안 움직이므로 사다리를 못 옮기면 렙 상단·미달 그대로 남는다(loading.ts). */
export const BODYWEIGHT_HOLD_REASONS = ["hit_top_reps", "missed_reps"];

const LOWER_MUSCLES = new Set(["quadriceps", "hamstrings", "glutes", "lower back"]);
const LIFT_SESSIONS = new Set(["lift", "lift_plus_cardio"]);
const MAX_SETS_PER_EXERCISE = 10;

interface PlanExercise {
  exercise_id?: unknown;
  modality?: unknown;
  order?: unknown;
  sets?: unknown;
  cardio_detail?: unknown;
  progression_decision?: unknown;
  circuit?: unknown;
}

interface PlanDay {
  day_index?: unknown;
  session_type?: unknown;
  exercises?: unknown;
}

/**
 * Checks a plan against schema **and** value rules.
 * Returns a flat list of problems, empty when the plan is good — the pipeline
 * feeds these into its ≤2 repair retries (S-GEN-8).
 */
export function checkPlanRules(plan: unknown, daysPerWeek: number): string[] {
  const problems: string[] = [];

  const schema = checkWeeklyPlan(plan);
  if (!schema.ok) problems.push(...schema.errors.map((error) => `schema: ${error}`));

  const root = plan as { week?: unknown; safety?: unknown; plan_meta?: unknown } | null;
  if (!root || typeof root !== "object") return [...problems, "plan is not an object"];

  const days = Array.isArray(root.week) ? (root.week as PlanDay[]) : [];
  if (days.length > 7) problems.push(`week has ${days.length} days (max 7)`);

  const seenDays = new Set<number>();
  let liftSessions = 0;
  const weeklySetsByGroup = new Map<string, number>();
  const planExerciseIds = new Set<string>();

  for (const day of days) {
    const dayIndex = typeof day.day_index === "number" ? day.day_index : -1;
    if (seenDays.has(dayIndex)) problems.push(`duplicate day_index: ${dayIndex}`);
    seenDays.add(dayIndex);

    const sessionType = typeof day.session_type === "string" ? day.session_type : "";
    if (LIFT_SESSIONS.has(sessionType)) liftSessions += 1;

    const exercises = Array.isArray(day.exercises) ? (day.exercises as PlanExercise[]) : [];
    const heavyLower = exercises.some((exercise) => {
      const catalogued = typeof exercise.exercise_id === "string" ? byId(exercise.exercise_id) : undefined;
      return (
        catalogued?.mechanic === "compound" &&
        catalogued.primary_muscles.some((muscle) => LOWER_MUSCLES.has(muscle))
      );
    });

    const seenOrders = new Set<number>();
    for (const exercise of exercises) {
      const exerciseId = typeof exercise.exercise_id === "string" ? exercise.exercise_id : "";
      // Two exercises claiming the same position make the day's order ambiguous.
      if (typeof exercise.order === "number") {
        if (seenOrders.has(exercise.order)) {
          problems.push(`day ${dayIndex}: duplicate exercise order ${exercise.order}`);
        }
        seenOrders.add(exercise.order);
      }
      if (exerciseId) planExerciseIds.add(exerciseId);

      const catalogued = exerciseId ? byId(exerciseId) : undefined;
      if (!catalogued) {
        problems.push(`unknown exercise_id in plan: ${exerciseId || "(missing)"}`);
      }

      if (exercise.modality === "cardio") {
        const detail = exercise.cardio_detail as { placement?: unknown } | undefined;
        // S-GEN-6: cardio must not share a session with heavy lower-body work.
        if (heavyLower && detail?.placement === "after_lifting") {
          problems.push(`cardio shares a session with heavy lower work on day ${dayIndex}`);
        }
        continue;
      }

      const sets = Array.isArray(exercise.sets) ? (exercise.sets as Record<string, unknown>[]) : [];
      if (sets.length < 1 || sets.length > MAX_SETS_PER_EXERCISE) {
        problems.push(`${exerciseId} has ${sets.length} sets (allowed 1–${MAX_SETS_PER_EXERCISE})`);
      }

      let workingSets = 0;
      for (const set of sets) {
        const low = set.target_reps_low;
        const high = set.target_reps_high;
        if (typeof low === "number" && typeof high === "number" && low > high) {
          problems.push(`${exerciseId} set ${String(set.set_number)}: reps ${low} > ${high}`);
        }
        if (set.set_kind === "working") workingSets += 1;
      }

      // S-GEN-5: weekly working sets per cap group, charged on primary muscles. 서킷은 유산소 자리라(D101 ④)
      // 근력 볼륨 상한에 세지 않는다 — 세면 스쿼트 100 서킷 하나로 하체 상한을 넘는다.
      if (catalogued && !exercise.circuit) {
        for (const group of capGroupsOfId(exerciseId)) {
          weeklySetsByGroup.set(group, (weeklySetsByGroup.get(group) ?? 0) + workingSets);
        }
      }

      problems.push(...checkProgression(exerciseId, exercise.progression_decision, sets));
    }
  }

  if (liftSessions !== daysPerWeek) {
    problems.push(`${liftSessions} lifting sessions for days_per_week=${daysPerWeek}`);
  }

  // Checked against the caps the plan itself publishes: a plan that claims a cap
  // and then exceeds it is broken regardless of what the code constant says.
  const safetyRoot = root.safety as { weekly_volume_caps?: unknown } | undefined;
  const publishedCaps = (safetyRoot?.weekly_volume_caps ?? {}) as Record<string, unknown>;
  for (const group of Object.keys(WEEKLY_VOLUME_CAPS)) {
    const cap = publishedCaps[group];
    if (typeof cap !== "number" || !Number.isInteger(cap) || cap <= 0) {
      problems.push(`safety.weekly_volume_caps.${group} is missing or not a positive integer`);
    }
  }
  for (const [group, sets] of weeklySetsByGroup) {
    const cap = publishedCaps[group];
    if (typeof cap === "number" && sets > cap) {
      problems.push(`${group} weekly sets ${sets} exceed cap ${cap}`);
    }
  }

  // S-GEN-4: an excluded exercise must not be back in the week.
  const safety = root.safety as { excluded_exercise_ids?: unknown; disclaimer?: unknown } | undefined;
  const excluded = Array.isArray(safety?.excluded_exercise_ids)
    ? (safety!.excluded_exercise_ids as unknown[]).filter((id): id is string => typeof id === "string")
    : [];
  for (const id of excluded) {
    if (planExerciseIds.has(id)) problems.push(`excluded exercise is still in the week: ${id}`);
  }

  // INV-6: the disclaimer rides on every plan, in both documented places.
  const meta = root.plan_meta as { disclaimer?: unknown } | undefined;
  if (typeof meta?.disclaimer !== "string" || meta.disclaimer.trim().length === 0) {
    problems.push("plan_meta.disclaimer is missing");
  }
  if (typeof safety?.disclaimer !== "string" || safety.disclaimer.trim().length === 0) {
    problems.push("safety.disclaimer is missing");
  }

  return problems;
}

/**
 * A progression decision must be internally consistent: an "increase" that lowers
 * the load, or one with no target at all, is a lie the artifact would carry into
 * the user's Drive folder.
 */
function checkProgression(
  exerciseId: string,
  decision: unknown,
  sets: Record<string, unknown>[],
): string[] {
  if (decision === null || decision === undefined) return []; // week 1 — allowed
  const problems: string[] = [];
  const value = decision as {
    decision?: unknown;
    reason_code?: unknown;
    from_load_kg?: unknown;
    to_load_kg?: unknown;
  };
  const kind = typeof value.decision === "string" ? value.decision : "";
  const reason = typeof value.reason_code === "string" ? value.reason_code : "";
  const from = typeof value.from_load_kg === "number" ? value.from_load_kg : null;
  const to = typeof value.to_load_kg === "number" ? value.to_load_kg : null;

  const allowed =
    kind === "hold" && byId(exerciseId)?.modality === "bodyweight"
      ? [...ALLOWED_REASONS.hold, ...BODYWEIGHT_HOLD_REASONS]
      : ALLOWED_REASONS[kind];
  if (!allowed) return [`${exerciseId}: unknown progression decision "${kind}"`];
  if (!allowed.includes(reason)) {
    problems.push(`${exerciseId}: decision ${kind} cannot carry reason ${reason || "(missing)"}`);
  }
  for (const [label, load] of [["from_load_kg", from], ["to_load_kg", to]] as const) {
    if (load !== null && load < 0) problems.push(`${exerciseId}: ${label} is negative (${load})`);
  }

  if (kind === "increase") {
    if (from === null || to === null) {
      problems.push(`${exerciseId}: increase needs both from_load_kg and to_load_kg`);
    } else if (to <= from) {
      problems.push(`${exerciseId}: increase must raise the load (${from} → ${to})`);
    }
  }
  if (kind === "decrease") {
    if (from === null || to === null) {
      problems.push(`${exerciseId}: decrease needs both from_load_kg and to_load_kg`);
    } else if (to >= from) {
      problems.push(`${exerciseId}: decrease must lower the load (${from} → ${to})`);
    }
  }
  if (kind === "hold" && from !== null && to !== null && from !== to) {
    problems.push(`${exerciseId}: hold must keep the load (${from} → ${to})`);
  }
  if (kind === "substitute" && value.to_load_kg !== null) {
    problems.push(`${exerciseId}: substitute must not carry a target load`);
  }

  // The working sets have to actually prescribe what the decision decided.
  const expected = kind === "substitute" ? null : to;
  for (const set of sets) {
    if (set.set_kind !== "working") continue;
    const target = set.target_load_kg === undefined ? null : set.target_load_kg;
    if (expected !== null && target !== expected) {
      problems.push(
        `${exerciseId} set ${String(set.set_number)}: target ${String(target)} disagrees with decision ${expected}`,
      );
    }
    if (expected === null && kind === "substitute" && target !== null) {
      problems.push(`${exerciseId} set ${String(set.set_number)}: substitute must not prescribe a load`);
    }
  }

  return problems;
}

/** Cap groups charged by an exercise id, or none when it is not in the catalogue. */
function capGroupsOfId(exerciseId: string): string[] {
  const exercise = byId(exerciseId);
  return exercise ? capGroupsOf(exercise) : [];
}
