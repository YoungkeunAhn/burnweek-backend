/** 실측 지표 묶음(2차 model-ab · 3차 hive-ab 공용). 플랜 원문은 넣지 않는다. */
import type { CallLog } from "./cli";
import type { EvalResult } from "./run";
import { EVAL_PROFILES } from "../fixtures/golden-profiles";

export function pct(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]!;
}
export const mean = (v: number[]) => (v.length === 0 ? null : Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100);

/** 4주차 프로필: 지난주 기록 종목이 이번 플랜에 남은 비율. */
export function continuity(result: EvalResult): number | null {
  const profile = EVAL_PROFILES.find((p) => p.id === result.profileId);
  const logged = (profile?.priorLogs as Array<{ exercises: Array<{ exercise_id: string }> }> | undefined)?.flatMap((s) => s.exercises.map((e) => e.exercise_id));
  if (!logged?.length || !result.plan) return null;
  const ids = new Set((result.plan as { week: Array<{ exercises: Array<{ exercise_id: string }> }> }).week.flatMap((d) => d.exercises.map((e) => e.exercise_id)));
  return logged.filter((id) => ids.has(id)).length / logged.length;
}

export function aggregate(results: EvalResult[], calls: Array<Pick<CallLog, "ms" | "ok">> = []) {
  const ok = results.filter((r) => r.status === "ok" && r.metrics);
  const m = ok.map((r) => r.metrics!);
  const glute = ok.find((r) => r.profileId === "beginner-glute-focus")?.metrics?.setsByMuscle.glutes ?? null;
  const week4 = ok.find((r) => r.profileId === "week4-logged-fullgym");
  return {
    n: results.length,
    ok: ok.length,
    repairs: results.filter((r) => (r.llmCalls ?? 1) > 1).length,
    latency_ms_p50: pct(calls.filter((c) => c.ok).map((c) => c.ms), 50),
    latency_ms_p90: pct(calls.filter((c) => c.ok).map((c) => c.ms), 90),
    tool_violations: m.reduce((a, x) => a + x.toolViolations.length, 0),
    contraindication_violations: m.reduce((a, x) => a + x.contraindicationViolations.length, 0),
    rule_problems: m.reduce((a, x) => a + x.ruleProblems.length, 0),
    basic_ratio_mean: mean(m.map((x) => x.basicRatio)),
    push_pull_mean: mean(m.filter((x) => x.pushPullRatio !== null).map((x) => x.pushPullRatio!)),
    exercises_mean: mean(m.map((x) => x.exerciseCount)),
    glute_focus_glute_sets: glute,
    week4_continuity: week4 ? continuity(week4) : null,
  };
}

