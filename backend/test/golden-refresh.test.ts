/**
 * Golden-draft refresh (001 T5.2/T5.3). **Opt-in, costs real LLM calls:**
 *
 *   bash:       GOLDEN_REFRESH=1 npx vitest run test/golden-refresh.test.ts
 *   PowerShell: $env:GOLDEN_REFRESH=1; npx vitest run test/golden-refresh.test.ts
 *
 * Calls the live provider once per golden profile and commits the resulting
 * DraftPlan to `fixtures/golden-drafts.json`, together with the measured
 * wall-clock time (the p95 sample set for S-GEN-13). `golden-set.test.ts` then
 * runs offline against those drafts, so a failure there means *our engine*
 * changed rather than the model having a bad day.
 *
 * Skipped by default — CI must never spend money or depend on a remote model.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/config";
import { createProvider, type DraftRaw, type LLMProvider } from "../src/llm";
import { generatePlan } from "../src/generation/handler";
import { GOLDEN_PROFILES } from "./fixtures/golden-profiles";
import { loadEnv } from "./live-env";

const REFRESH = process.env.GOLDEN_REFRESH === "1";
const CONCURRENCY = 4; // gentle on the provider's rate limit

/** Wraps the real provider and keeps the draft of the attempt that succeeded. */
function recording(provider: LLMProvider): LLMProvider & { last?: DraftRaw; attempts: number } {
  const wrapper = {
    attempts: 0,
    last: undefined as DraftRaw | undefined,
    async generateDraft(req: Parameters<LLMProvider["generateDraft"]>[0]) {
      wrapper.attempts += 1;
      wrapper.last = await provider.generateDraft(req);
      return wrapper.last;
    },
  };
  return wrapper as LLMProvider & { last?: DraftRaw; attempts: number };
}

describe("golden draft refresh (live)", () => {
  it.skipIf(!REFRESH)(
    "generates and commits one DraftPlan per golden profile",
    async () => {
      loadEnv();
      const config = buildConfig(process.env);
      const cases: Record<string, unknown> = {};
      const failures: string[] = [];

      const queue = [...GOLDEN_PROFILES];
      const worker = async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          const provider = recording(createProvider(config.llm));
          const started = Date.now();
          const res = await generatePlan(
            {
              user_id: item.id,
              week_start_date: "2026-08-17",
              fcm_token: "golden",
              profile: item.profile,
              prior_logs: item.priorLogs ?? [],
              ...(item.weekNumber ? { week_number: item.weekNumber } : {}),
            },
            { config, provider },
          );
          const elapsedMs = Date.now() - started;
          if (res.status !== "ok") {
            failures.push(`${item.id}: ${res.status} — ${res.message}`);
            continue;
          }
          cases[item.id] = {
            why: item.why,
            attempts: provider.attempts,
            elapsed_ms: elapsedMs,
            model: provider.last?.model,
            draft: provider.last?.draft,
          };
          // eslint-disable-next-line no-console
          console.log(`[golden] ${item.id} ok in ${(elapsedMs / 1000).toFixed(1)}s (${provider.attempts} call(s))`);
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, worker));

      const path = join(__dirname, "fixtures", "golden-drafts.json");
      const ordered: Record<string, unknown> = {};
      for (const item of GOLDEN_PROFILES) if (cases[item.id]) ordered[item.id] = cases[item.id];
      writeFileSync(
        path,
        JSON.stringify({ provider: config.llm.provider, model: config.llm.model, cases: ordered }, null, 2) + "\n",
        "utf8",
      );

      expect(failures).toEqual([]);
      expect(Object.keys(ordered)).toHaveLength(GOLDEN_PROFILES.length);

      // This is the only place live latency exists, so S-GEN-13 is asserted here
      // rather than against the committed numbers (which cannot regress on their
      // own). Nearest-rank p95 over the 12 runs.
      const elapsed = Object.values(ordered)
        .map((c) => (c as { elapsed_ms: number }).elapsed_ms)
        .sort((a, b) => a - b);
      const p95 = elapsed[Math.ceil(0.95 * elapsed.length) - 1]!;
      // eslint-disable-next-line no-console
      console.log(`[golden] live generation p95 = ${(p95 / 1000).toFixed(1)}s`);
      expect(p95).toBeLessThanOrEqual(540_000);
    },
    900_000,
  );
});
