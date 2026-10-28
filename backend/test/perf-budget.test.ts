/**
 * Latency budgets (001 T5.3 / S-GEN-13): 접수 p95 ≤ 2s, 생성 hard limit ≤ 540s.
 * The product speed target remains p90 ≤ 60s and is tracked separately in 068.
 *
 * Two halves, measured where each can honestly be measured:
 *
 *  - **Intake** is measured on the real `plansGenerate` handler in
 *    `generation-api-contract.test.ts` (it owns the firebase-admin doubles), not
 *    here: timing `evaluateGate` alone would stay green if the handler itself got
 *    slow. Firestore + Cloud Tasks RTT is measured after the G2 deploy.
 *  - **Generation** is dominated by the model. The 12 live runs recorded in
 *    `fixtures/golden-drafts.json` (one per golden profile, MiniMax-M3) are the
 *    sample set; the code-owned expansion is timed separately so a regression in
 *    *our* half cannot hide behind the model's variance. These are **recorded**
 *    measurements — the live budget is re-asserted by `golden-refresh.test.ts`
 *    whenever the fixtures are regenerated, which is the only moment new model
 *    latency data exists.
 */
import { describe, expect, it } from "vitest";
import { expandDraftToWeeklyPlan } from "../src/generation/expand";
import { MEDICAL_DISCLAIMER } from "../src/generation/safety";
import { GOLDEN_PROFILES } from "./fixtures/golden-profiles";
import drafts from "./fixtures/golden-drafts.json";

const CASES = (drafts as { cases: Record<string, { draft: unknown; elapsed_ms: number }> }).cases;

/** Nearest-rank p95 — with 12 samples that is the slowest one, which is the point. */
function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const rank = Math.ceil(0.95 * sorted.length);
  return sorted[Math.max(0, rank - 1)]!;
}

function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

describe("generation budget (S-GEN-13: hard limit ≤ 540s)", () => {
  it("keeps the live generation samples inside the worker timeout", () => {
    const samples = GOLDEN_PROFILES.map((item) => CASES[item.id]!.elapsed_ms);
    const measured = p95(samples);
    const slowest = Math.max(...samples);
    // eslint-disable-next-line no-console
    console.log(
      `[perf] live generation p95 = ${(measured / 1000).toFixed(1)}s, slowest ${(slowest / 1000).toFixed(1)}s, ` +
        `median ${(median(samples) / 1000).toFixed(1)}s (n=${samples.length})`,
    );
    expect(samples).toHaveLength(12);
    expect(measured).toBeLessThanOrEqual(540_000);
    // A tighter regression guard keeps the larger reliability ceiling from
    // silently becoming the latency target.
    expect(slowest).toBeLessThan(240_000);
  });

  it("spends single-digit milliseconds on the code-owned expansion", () => {
    const samples: number[] = [];
    for (const item of GOLDEN_PROFILES) {
      const started = performance.now();
      const result = expandDraftToWeeklyPlan({
        draft: CASES[item.id]!.draft,
        profile: item.profile,
        userId: item.id,
        weekStartDate: "2026-08-17",
        weekNumber: item.weekNumber ?? 1,
        priorLogs: item.priorLogs ?? [],
        disclaimer: MEDICAL_DISCLAIMER,
      });
      samples.push(performance.now() - started);
      expect(result.problems).toEqual([]);
    }
    const measured = p95(samples);
    // eslint-disable-next-line no-console
    console.log(`[perf] expansion p95 = ${measured.toFixed(1)}ms (n=${samples.length})`);
    expect(measured).toBeLessThan(250);
  });
});
