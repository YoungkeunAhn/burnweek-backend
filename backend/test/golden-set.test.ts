/**
 * Golden set (001 T5.2) — 12 representative profiles, offline and deterministic.
 *
 * The DraftPlans in `fixtures/golden-drafts.json` came from the live model once
 * (`GOLDEN_REFRESH=1 npx vitest run test/golden-refresh.test.ts`). Here we run the
 * code-owned expansion over them and assert the plan is schema- and rule-clean
 * plus the invariants each profile exists to prove. A failure means our engine
 * regressed — no network, no cost, no model variance.
 */
import { describe, expect, it } from "vitest";
import { expandDraftToWeeklyPlan } from "../src/generation/expand";
import { checkWeeklyPlan } from "../src/schemas/validate";
import { MEDICAL_DISCLAIMER } from "../src/generation/safety";
import { allowedGeneratedExerciseIds } from "../src/generation/exercise-policy";
import { byId } from "../src/data/exercises";
import { startLoadFor } from "../src/data/constants";
import { GOLDEN_PROFILES, type GoldenProfile } from "./fixtures/golden-profiles";
import drafts from "./fixtures/golden-drafts.json";

interface PlanSet {
  set_kind: string;
  target_load_kg: number | null;
}
interface PlanExercise {
  exercise_id: string;
  /** `bodyweight` is a lifting modality too — only `cardio` is not. */
  modality: "strength" | "bodyweight" | "cardio";
  sets?: PlanSet[];
  cardio_detail?: { style: string; placement: string; duration_min: number };
  progression_decision?: { decision: string; reason_code: string } | null;
}
interface Plan {
  plan_meta: { week_number: number; days_per_week?: number; split_type: string };
  week: { day_index: number; session_type: string; exercises: PlanExercise[] }[];
  safety: { excluded_exercise_ids: string[]; disclaimer: string };
}

const CASES = (drafts as { cases: Record<string, { draft: unknown }> }).cases;

function expand(item: GoldenProfile) {
  const fixture = CASES[item.id];
  if (!fixture) throw new Error(`no committed draft for ${item.id} — run the refresh script`);
  return expandDraftToWeeklyPlan({
    draft: fixture.draft,
    profile: item.profile,
    userId: item.id,
    weekStartDate: "2026-08-17",
    weekNumber: item.weekNumber ?? 1,
    priorLogs: item.priorLogs ?? [],
    allowedGeneratedExerciseIds: allowedGeneratedExerciseIds(item.profile),
    disclaimer: MEDICAL_DISCLAIMER,
  });
}

function exercises(plan: Plan): PlanExercise[] {
  return plan.week.flatMap((day) => day.exercises);
}

describe("golden set — every profile expands to a valid plan", () => {
  it("has a committed draft for every profile", () => {
    expect(Object.keys(CASES).sort()).toEqual(GOLDEN_PROFILES.map((p) => p.id).sort());
  });

  for (const item of GOLDEN_PROFILES) {
    describe(`${item.id} (${item.why})`, () => {
      const result = expand(item);
      const plan = result.plan as Plan;

      it("passes the value rules and the WeeklyPlan v1 schema", () => {
        expect(result.problems).toEqual([]);
        expect(checkWeeklyPlan(plan).ok).toBe(true);
      });

      it("holds the safety invariants", () => {
        expect(plan.safety.disclaimer.length).toBeGreaterThan(0);
        const ids = exercises(plan).map((e) => e.exercise_id);
        // No excluded exercise may reappear anywhere in the week (S-GEN-4).
        for (const excluded of plan.safety.excluded_exercise_ids) {
          expect(ids).not.toContain(excluded);
        }
        // Every id is a real catalogue entry — no invented ids survive.
        for (const id of ids) {
          if (id.startsWith("cardio_")) continue; // synthetic cardio slot
          expect(byId(id), id).toBeDefined();
        }
      });

      it("trains the requested number of days", () => {
        const lift = plan.week.filter(
          (d) => d.session_type === "lift" || d.session_type === "lift_plus_cardio",
        );
        expect(lift).toHaveLength(item.profile.days_per_week);
      });

      it(`matches cardio preference "${item.profile.cardio_pref}"`, () => {
        const cardio = exercises(plan).filter((e) => e.modality === "cardio");
        if (item.profile.cardio_pref === "none") expect(cardio).toHaveLength(0);
        else expect(cardio.length).toBeGreaterThan(0);
      });

      if (item.profile.environment === "bodyweight_only") {
        it("prescribes body-only equipment", () => {
          for (const e of exercises(plan)) {
            if (e.modality === "cardio") {
              expect(e.exercise_id).toBe("trail_running_walking");
              continue;
            }
            expect(byId(e.exercise_id)?.equipment, e.exercise_id).toBe("body only");
            // 「body only」여도 철봉·의자가 필요한 종목이 있다(N1 T1-1 · 백로그 운동목록 02 §1.1).
            expect(byId(e.exercise_id)?.requires ?? [], e.exercise_id).toEqual([]);
          }
        });
      }

      if (item.profile.injuries.length > 0) {
        it("excludes something for the reported injury", () => {
          expect(plan.safety.excluded_exercise_ids.length + result.warnings.length).toBeGreaterThan(0);
        });
      }


      if (item.weekNumber === 1 || !item.weekNumber) {
        it("seeds week-1 loads only for beginners, from the equipment table (D55 ② · T2-1)", () => {
          const lifts = exercises(plan).filter((e) => e.modality !== "cardio");
          const working = lifts.flatMap((e) => e.sets ?? []).filter((s) => s.set_kind === "working");
          expect(working.length).toBeGreaterThan(0);
          for (const e of lifts) {
            const expected = startLoadFor(byId(e.exercise_id)!, item.profile.experience_level);
            for (const s of (e.sets ?? []).filter((s) => s.set_kind === "working")) expect(s.target_load_kg, e.exercise_id).toBe(expected);
          }
          if (item.profile.experience_level !== "beginner") expect(working.every((s) => s.target_load_kg === null)).toBe(true);
        });
      }
    });
  }
});

/**
 * Progression is asserted separately from the per-profile expansion above,
 * because the model is free to *substitute* the logged lift (the pain fixture
 * swapped `barbell_squat` for `dumbbell_squat` on its own). Judging the feedback
 * loop on "if the lift happens to be there" would let a regression pass silently,
 * so all three prior-log variants are run against the one draft that does contain
 * the logged lift.
 */
describe("golden set — week-2 feedback loop (S-GEN-10/11)", () => {
  const draftWithSquat = CASES["week2-progression-increase"]!.draft;

  const expectations: Record<string, string[]> = {
    "week2-progression-increase": ["increase"],
    "week2-progression-pain": ["decrease", "substitute"],
    "week2-progression-missed": ["decrease", "substitute"],
  };

  for (const item of GOLDEN_PROFILES.filter((p) => expectations[p.id])) {
    it(`${item.id} → ${expectations[item.id]!.join("|")}`, () => {
      const result = expandDraftToWeeklyPlan({
        draft: draftWithSquat,
        profile: item.profile,
        userId: item.id,
        weekStartDate: "2026-08-17",
        weekNumber: 2,
        priorLogs: item.priorLogs ?? [],
        disclaimer: MEDICAL_DISCLAIMER,
      });
      expect(result.problems).toEqual([]);

      const squat = exercises(result.plan as Plan).find((e) => e.exercise_id === "barbell_squat");
      expect(squat, "the fixture draft must keep the logged lift").toBeDefined();
      const decision = squat!.progression_decision;
      expect(decision).toBeTruthy();
      expect(expectations[item.id]!).toContain(decision!.decision);
      // The warmup sets in the log must never drive the decision (60kg working,
      // 30kg warmup): a decision anchored on the warmup would move from 30.
      if (decision!.decision !== "substitute") {
        expect((decision as unknown as { from_load_kg: number }).from_load_kg).toBe(60);
      }
    });
  }
});
