/**
 * Generation gate (FR-SAFE-3/4, INV-6). Runs in the BACKEND, BEFORE any LLM call.
 * Taxonomy is code-owned and fixed (docs/architecture/02-data-model.md §A).
 *
 * - hard flag present  → non-bypassable block, ZERO LLM calls (blocked_red_flag).
 * - low_risk flag(s)   → allowed, surfaced as warnings for downstream exclusion.
 */
import type { RedFlagHard, RedFlagLowRisk, UserProfile } from "./types";

export const HARD_RED_FLAGS: readonly RedFlagHard[] = [
  "pregnancy",
  "cardiac_condition",
  "recent_surgery",
  "acute_injury",
  "chest_pain_on_exertion",
];

export const LOW_RISK_FLAGS: readonly RedFlagLowRisk[] = [
  "mild_joint_discomfort",
  "managed_hypertension",
  "general_soreness",
];

export interface GateResult {
  blocked: boolean;
  hardHits: RedFlagHard[];
  /** e.g. "low_risk_flag:managed_hypertension" — passed to the response warnings. */
  warnings: string[];
}

export function evaluateGate(profile: UserProfile): GateResult {
  const hard = profile.red_flags?.hard ?? [];
  const lowRisk = profile.red_flags?.low_risk ?? [];

  const hardHits = hard.filter((f) => HARD_RED_FLAGS.includes(f));
  const warnings = lowRisk
    .filter((f) => LOW_RISK_FLAGS.includes(f))
    .map((f) => `low_risk_flag:${f}`);

  return { blocked: hardHits.length > 0, hardHits, warnings };
}
