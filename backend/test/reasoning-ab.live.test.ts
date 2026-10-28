/**
 * MiniMax M3 reasoning A/B (live, opt-in, paid).
 *
 * Runs each profile as a paired request: adaptive and disabled start together,
 * while pair-level concurrency stays bounded. Both arms use the same completion
 * cap when one is explicitly supplied; the default omits it from both arms so
 * the comparison isolates reasoning mode. Results are summaries only — no API
 * key or user data is written.
 *
 * PowerShell:
 *   $env:REASONING_AB='1'
 *   $env:REASONING_AB_REPETITIONS='3'
 *   $env:REASONING_AB_CONCURRENCY='2'
 *   $env:REASONING_AB_OUTPUT='test/fixtures/reasoning-ab-2026-09-23.json'
 *   pnpm exec vitest run test/reasoning-ab.live.test.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config";
import { buildConfig } from "../src/config";
import { allowedEquipment, byId, candidateIdsFor, resolve as resolveExercise } from "../src/data/exercises";
import { generatePlan } from "../src/generation/handler";
import type { GenerateResponse, UserProfile } from "../src/generation/types";
import { createProvider, type DraftRaw, type LLMProvider } from "../src/llm";
import { checkWeeklyPlan } from "../src/schemas/validate";
import { GOLDEN_PROFILES, type GoldenProfile } from "./fixtures/golden-profiles";
import { loadEnv } from "./live-env";

const ENABLED = process.env.REASONING_AB === "1";
const REPETITIONS = positiveInt(process.env.REASONING_AB_REPETITIONS, 3);
const PAIR_CONCURRENCY = positiveInt(process.env.REASONING_AB_CONCURRENCY, 2);
const MAX_COMPLETION_TOKENS = optionalPositiveInt(process.env.REASONING_AB_MAX_COMPLETION_TOKENS);
const OUTPUT = process.env.REASONING_AB_OUTPUT ?? "test/results/reasoning-ab-latest.json";

type Mode = "adaptive" | "disabled";

interface AttemptMetric {
  elapsed_ms: number;
  model: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

interface QualityAudit {
  score: number;
  session_count_pass_rate: number;
  role_order_pass_rate: number;
  mechanic_order_pass_rate: number;
  unique_exercise_pass_rate: number;
  beginner_barbell_pass_rate: number;
}

interface ArmResult {
  profile_id: string;
  repetition: number;
  mode: Mode;
  elapsed_ms: number;
  status: GenerateResponse["status"] | "threw";
  message?: string;
  llm_calls: number;
  total_tokens?: number;
  attempts: AttemptMetric[];
  hard_pass: boolean;
  hard_violations: string[];
  quality: QualityAudit;
  draft_exercise_ids: string[][];
  final_exercise_ids: string[][];
}

interface RawDraftItem {
  kind?: unknown;
  exercise_id?: unknown;
  role?: unknown;
  order?: unknown;
}

interface RawDraftDay {
  day_index?: unknown;
  session_type?: unknown;
  items?: unknown;
}

interface PlanExercise {
  exercise_id?: unknown;
  modality?: unknown;
}

interface PlanDay {
  day_index?: unknown;
  session_type?: unknown;
  exercises?: unknown;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function optionalPositiveInt(raw: string | undefined): number | undefined {
  if (!raw?.trim()) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("REASONING_AB_MAX_COMPLETION_TOKENS must be a positive integer when set");
  }
  return value;
}

function recording(provider: LLMProvider): LLMProvider & { attempts: AttemptMetric[] } {
  const wrapper = {
    attempts: [] as AttemptMetric[],
    async generateDraft(req: Parameters<LLMProvider["generateDraft"]>[0]): Promise<DraftRaw> {
      const started = Date.now();
      const raw = await provider.generateDraft(req);
      wrapper.attempts.push({
        elapsed_ms: Date.now() - started,
        model: raw.model,
        ...(raw.usage?.promptTokens !== undefined ? { prompt_tokens: raw.usage.promptTokens } : {}),
        ...(raw.usage?.completionTokens !== undefined
          ? { completion_tokens: raw.usage.completionTokens }
          : {}),
        ...(raw.usage?.totalTokens !== undefined ? { total_tokens: raw.usage.totalTokens } : {}),
      });
      return raw;
    },
  };
  return wrapper as LLMProvider & { attempts: AttemptMetric[] };
}

function draftDays(draft: unknown): RawDraftDay[] {
  const week = (draft as { week?: unknown } | null)?.week;
  return Array.isArray(week) ? (week as RawDraftDay[]) : [];
}

function strengthItems(day: RawDraftDay): RawDraftItem[] {
  return Array.isArray(day.items)
    ? (day.items as RawDraftItem[]).filter((item) => item.kind === "strength")
    : [];
}

function planDays(plan: unknown): PlanDay[] {
  const week = (plan as { week?: unknown } | null)?.week;
  return Array.isArray(week) ? (week as PlanDay[]) : [];
}

function finalStrengthIds(plan: unknown): string[][] {
  return planDays(plan)
    .filter((day) => day.session_type === "lift" || day.session_type === "lift_plus_cardio")
    .map((day) =>
      (Array.isArray(day.exercises) ? (day.exercises as PlanExercise[]) : [])
        .filter((exercise) => exercise.modality !== "cardio" && typeof exercise.exercise_id === "string")
        .map((exercise) => exercise.exercise_id as string),
    );
}

function draftStrengthIds(draft: unknown): string[][] {
  return draftDays(draft)
    .filter((day) => day.session_type === "lift" || day.session_type === "lift_plus_cardio")
    .map((day) =>
      strengthItems(day).flatMap((item) =>
        typeof item.exercise_id === "string" ? [item.exercise_id] : [],
      ),
    );
}

function auditHard(profile: UserProfile, result: GenerateResponse): string[] {
  const violations: string[] = [];
  if (result.status !== "ok") return [`pipeline:${result.status}:${result.message ?? "unknown"}`];

  const weekly = checkWeeklyPlan(result.plan);
  if (!weekly.ok) violations.push(`weekly_schema:${weekly.errors.join("|")}`);

  const candidates = new Set(candidateIdsFor(profile));
  for (const [dayIndex, ids] of draftStrengthIds(result.draft).entries()) {
    for (const requestedId of ids) {
      const resolved = resolveExercise(requestedId);
      if (!resolved) violations.push(`draft_unresolved:day${dayIndex}:${requestedId}`);
      else if (!candidates.has(resolved.id)) {
        violations.push(`draft_outside_candidates:day${dayIndex}:${requestedId}->${resolved.id}`);
      }
    }
  }

  const allowed = allowedEquipment(profile);
  for (const [dayIndex, ids] of finalStrengthIds(result.plan).entries()) {
    for (const id of ids) {
      const exercise = byId(id);
      if (!exercise) violations.push(`final_unknown:day${dayIndex}:${id}`);
      else if (allowed && !allowed.has(exercise.equipment)) {
        violations.push(`final_equipment:day${dayIndex}:${id}:${exercise.equipment}`);
      }
    }
  }

  const liftDays = planDays(result.plan).filter(
    (day) => day.session_type === "lift" || day.session_type === "lift_plus_cardio",
  );
  if (liftDays.length !== profile.days_per_week) {
    violations.push(`lift_days:${liftDays.length}/${profile.days_per_week}`);
  }

  const cardioCount = planDays(result.plan).flatMap((day) =>
    Array.isArray(day.exercises) ? (day.exercises as PlanExercise[]) : [],
  ).filter((exercise) => exercise.modality === "cardio").length;
  if (profile.cardio_pref === "none" && cardioCount !== 0) violations.push(`cardio_expected_none:${cardioCount}`);
  if (profile.cardio_pref !== "none" && cardioCount === 0) violations.push("cardio_missing");

  return violations;
}

function auditQuality(profile: UserProfile, draft: unknown): QualityAudit {
  const days = draftDays(draft).filter(
    (day) => day.session_type === "lift" || day.session_type === "lift_plus_cardio",
  );
  if (days.length === 0) {
    return {
      score: 0,
      session_count_pass_rate: 0,
      role_order_pass_rate: 0,
      mechanic_order_pass_rate: 0,
      unique_exercise_pass_rate: 0,
      beginner_barbell_pass_rate: 0,
    };
  }

  let countPass = 0;
  let rolePass = 0;
  let mechanicPass = 0;
  let uniquePass = 0;
  let barbellPass = 0;
  const roleRank: Record<string, number> = { primary: 0, secondary: 1, accessory: 2 };

  for (const day of days) {
    const items = strengthItems(day)
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const ao = typeof a.item.order === "number" ? a.item.order : a.index + 1;
        const bo = typeof b.item.order === "number" ? b.item.order : b.index + 1;
        return ao - bo;
      });
    const exercises = items.map(({ item }) =>
      typeof item.exercise_id === "string" ? resolveExercise(item.exercise_id) : undefined,
    );

    if (items.length >= 4 && items.length <= 6) countPass += 1;

    const ranks = items.map(({ item }) =>
      typeof item.role === "string" && roleRank[item.role] !== undefined ? roleRank[item.role]! : 3,
    );
    if (ranks.every((rank, index) => index === 0 || ranks[index - 1]! <= rank)) rolePass += 1;

    const mechanics = exercises.map((exercise) =>
      exercise?.mechanic === "compound" ? 0 : exercise?.mechanic === "isolation" ? 1 : 0,
    );
    if (mechanics.every((rank, index) => index === 0 || mechanics[index - 1]! <= rank)) mechanicPass += 1;

    const ids = exercises.flatMap((exercise) => (exercise ? [exercise.id] : []));
    if (ids.length === new Set(ids).size) uniquePass += 1;

    const barbellCompounds = exercises.filter(
      (exercise) => exercise?.equipment === "barbell" && exercise.mechanic === "compound",
    ).length;
    if (profile.experience_level !== "beginner" || barbellCompounds <= 1) barbellPass += 1;
  }

  const divisor = days.length;
  const metrics = [countPass, rolePass, mechanicPass, uniquePass, barbellPass].map(
    (count) => count / divisor,
  );
  return {
    score: Number(((metrics.reduce((sum, value) => sum + value, 0) / metrics.length) * 100).toFixed(1)),
    session_count_pass_rate: Number(metrics[0]!.toFixed(3)),
    role_order_pass_rate: Number(metrics[1]!.toFixed(3)),
    mechanic_order_pass_rate: Number(metrics[2]!.toFixed(3)),
    unique_exercise_pass_rate: Number(metrics[3]!.toFixed(3)),
    beginner_barbell_pass_rate: Number(metrics[4]!.toFixed(3)),
  };
}

async function runArm(
  item: GoldenProfile,
  repetition: number,
  mode: Mode,
  baseConfig: AppConfig,
): Promise<ArmResult> {
  const llm = {
    ...baseConfig.llm,
    reasoningMode: mode,
    ...(MAX_COMPLETION_TOKENS !== undefined
      ? { maxCompletionTokens: MAX_COMPLETION_TOKENS }
      : { maxCompletionTokens: undefined }),
  } as const;
  const provider = recording(createProvider(llm));
  const config: AppConfig = { ...baseConfig, llm };
  const started = Date.now();
  let result: GenerateResponse;
  try {
    result = await generatePlan(
      {
        user_id: `reasoning-ab-${item.id}-${repetition}-${mode}`,
        week_start_date: "2026-09-21",
        profile: item.profile,
        prior_logs: item.priorLogs ?? [],
        ...(item.weekNumber ? { week_number: item.weekNumber } : {}),
      },
      { config, provider },
    );
  } catch (error) {
    return {
      profile_id: item.id,
      repetition,
      mode,
      elapsed_ms: Date.now() - started,
      status: "threw",
      message: (error as Error).message,
      llm_calls: provider.attempts.length,
      attempts: provider.attempts,
      hard_pass: false,
      hard_violations: [`threw:${(error as Error).message}`],
      quality: auditQuality(item.profile, undefined),
      draft_exercise_ids: [],
      final_exercise_ids: [],
    };
  }

  const violations = auditHard(item.profile, result);
  return {
    profile_id: item.id,
    repetition,
    mode,
    elapsed_ms: Date.now() - started,
    status: result.status,
    ...(result.message ? { message: result.message } : {}),
    llm_calls: result.telemetry?.llmCalls ?? provider.attempts.length,
    ...(result.telemetry?.totalTokens !== undefined ? { total_tokens: result.telemetry.totalTokens } : {}),
    attempts: provider.attempts,
    hard_pass: violations.length === 0,
    hard_violations: violations,
    quality: auditQuality(item.profile, result.draft),
    draft_exercise_ids: draftStrengthIds(result.draft),
    final_exercise_ids: finalStrengthIds(result.plan),
  };
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? null;
}

function average(values: number[]): number | null {
  return values.length === 0
    ? null
    : Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2));
}

function aggregate(results: ArmResult[], mode: Mode) {
  const arm = results.filter((result) => result.mode === mode);
  const elapsed = arm.map((result) => result.elapsed_ms);
  const tokens = arm.flatMap((result) =>
    result.total_tokens !== undefined ? [result.total_tokens] : [],
  );
  return {
    runs: arm.length,
    ok: arm.filter((result) => result.status === "ok").length,
    hard_pass: arm.filter((result) => result.hard_pass).length,
    hard_violations: arm.reduce((sum, result) => sum + result.hard_violations.length, 0),
    repair_runs: arm.filter((result) => result.llm_calls > 1).length,
    average_llm_calls: average(arm.map((result) => result.llm_calls)),
    elapsed_ms: {
      p50: percentile(elapsed, 0.5),
      p90: percentile(elapsed, 0.9),
      max: percentile(elapsed, 1),
    },
    total_tokens: {
      p50: percentile(tokens, 0.5),
      p90: percentile(tokens, 0.9),
    },
    average_quality_score: average(arm.map((result) => result.quality.score)),
  };
}

function jaccard(left: string[][], right: string[][]): number {
  const a = new Set(left.flat());
  const b = new Set(right.flat());
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 1;
  return [...a].filter((id) => b.has(id)).length / union.size;
}

function pairedSummary(results: ArmResult[]) {
  const byPair = new Map<string, Partial<Record<Mode, ArmResult>>>();
  for (const result of results) {
    const key = `${result.profile_id}#${result.repetition}`;
    const pair = byPair.get(key) ?? {};
    pair[result.mode] = result;
    byPair.set(key, pair);
  }
  const pairs = [...byPair.values()].flatMap((pair) =>
    pair.adaptive && pair.disabled ? [{ adaptive: pair.adaptive, disabled: pair.disabled }] : [],
  );
  const elapsedDelta = pairs.map((pair) => pair.disabled.elapsed_ms - pair.adaptive.elapsed_ms);
  const qualityDelta = pairs.map((pair) => pair.disabled.quality.score - pair.adaptive.quality.score);
  return {
    pairs: pairs.length,
    disabled_faster: pairs.filter((pair) => pair.disabled.elapsed_ms < pair.adaptive.elapsed_ms).length,
    median_elapsed_delta_ms_disabled_minus_adaptive: percentile(elapsedDelta, 0.5),
    average_quality_delta_disabled_minus_adaptive: average(qualityDelta),
    average_final_exercise_jaccard: average(
      pairs.map((pair) => jaccard(pair.adaptive.final_exercise_ids, pair.disabled.final_exercise_ids)),
    ),
  };
}

describe("MiniMax M3 reasoning A/B (live, paid)", () => {
  it.skipIf(!ENABLED)(
    "compares adaptive and disabled in parallel pairs without relaxing quality gates",
    async () => {
      loadEnv();
      const baseConfig = buildConfig(process.env);
      const filter = new Set(
        (process.env.REASONING_AB_PROFILE ?? "")
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean),
      );
      const profiles = filter.size > 0
        ? GOLDEN_PROFILES.filter((profile) => filter.has(profile.id))
        : GOLDEN_PROFILES;
      expect(profiles.length, "REASONING_AB_PROFILE did not match a golden profile").toBeGreaterThan(0);

      const tasks = profiles.flatMap((profile) =>
        Array.from({ length: REPETITIONS }, (_, repetition) => ({
          profile,
          repetition: repetition + 1,
        })),
      );
      const queue = [...tasks];
      const results: ArmResult[] = [];
      const worker = async () => {
        for (let task = queue.shift(); task; task = queue.shift()) {
          const [adaptive, disabled] = await Promise.all([
            runArm(task.profile, task.repetition, "adaptive", baseConfig),
            runArm(task.profile, task.repetition, "disabled", baseConfig),
          ]);
          results.push(adaptive, disabled);
          // eslint-disable-next-line no-console
          console.log(
            `[reasoning-ab] ${task.profile.id} #${task.repetition} ` +
              `adaptive=${(adaptive.elapsed_ms / 1000).toFixed(1)}s/${adaptive.status}/q${adaptive.quality.score} ` +
              `disabled=${(disabled.elapsed_ms / 1000).toFixed(1)}s/${disabled.status}/q${disabled.quality.score}`,
          );
        }
      };
      await Promise.all(Array.from({ length: Math.min(PAIR_CONCURRENCY, tasks.length) }, worker));

      results.sort(
        (a, b) =>
          a.profile_id.localeCompare(b.profile_id) ||
          a.repetition - b.repetition ||
          a.mode.localeCompare(b.mode),
      );
      const report = {
        generated_at: new Date().toISOString(),
        provider: baseConfig.llm.provider,
        model: baseConfig.llm.model,
        repetitions: REPETITIONS,
        pair_concurrency: PAIR_CONCURRENCY,
        max_completion_tokens_both_arms: MAX_COMPLETION_TOKENS ?? null,
        quality_note:
          "hard_pass is mandatory; quality_score is a deterministic 5-part structural rubric, not a guarantee of physiological outcomes",
        summary: {
          adaptive: aggregate(results, "adaptive"),
          disabled: aggregate(results, "disabled"),
          paired: pairedSummary(results),
        },
        results,
      };
      const outputPath = resolvePath(process.cwd(), OUTPUT);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      // eslint-disable-next-line no-console
      console.log(`[reasoning-ab] report=${outputPath}`);
      // eslint-disable-next-line no-console
      console.log(`[reasoning-ab] summary=${JSON.stringify(report.summary)}`);

      expect(results).toHaveLength(tasks.length * 2);
      expect(results.some((result) => result.status === "ok")).toBe(true);
    },
    7_200_000,
  );
});
