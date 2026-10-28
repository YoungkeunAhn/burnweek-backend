/**
 * Provider-swap regression (001 T5.4, ADR-0006/INV-4).
 *
 * ADR-0006 claims a vendor change is a config change. We prove it against the
 * local fake OpenAI-compatible host: the same golden draft must expand to a
 * byte-identical plan under every OpenAI-compatible provider name, and the
 * adapter must carry the configured key/model to whatever host it is pointed at.
 *
 * A real second vendor (GPT/Gemini keys) is not verified here — no key is
 * bundled anywhere near the app (INV-3) and a paid call in CI would be a poor
 * trade. That check is ready to run the moment a second key exists: point
 * `LLM_PROVIDER`/`LLM_BASE_URL`/`LLM_MODEL` at the other vendor in `.env` and run
 * `npm run verify:live` (001 T5.4 note).
 */
import { describe, expect, it } from "vitest";
import { generatePlan } from "../src/generation/handler";
import { checkWeeklyPlan } from "../src/schemas/validate";
import { createProvider } from "../src/llm";
import type { AppConfig } from "../src/config";
import { startFakeLlm, type FakeLlm } from "./fake-llm-server";
import { GOLDEN_PROFILES } from "./fixtures/golden-profiles";
import drafts from "./fixtures/golden-drafts.json";

const CASES = (drafts as { cases: Record<string, { draft: unknown }> }).cases;
const SAMPLE = GOLDEN_PROFILES[0]!; // beginner-2day-fullgym

function config(fakeLlm: FakeLlm, provider: string, model: string): AppConfig {
  return {
    llm: { provider, apiKey: "fake-key", baseUrl: fakeLlm.baseUrl, model },
    workerTimeoutSec: 540,
    maxRepairRetries: 2,
  };
}

/** `generated_at` is a wall-clock stamp; everything else must match exactly. */
function stableJson(plan: unknown): string {
  const copy = JSON.parse(JSON.stringify(plan)) as { plan_meta: Record<string, unknown> };
  delete copy.plan_meta.generated_at;
  return JSON.stringify(copy);
}

function request(item = SAMPLE) {
  return {
    user_id: "swap",
    week_start_date: "2026-08-17",
    fcm_token: "tok",
    profile: item.profile,
    prior_logs: [],
  };
}

const OPENAI_COMPATIBLE: Array<[string, string]> = [
  ["minimax", "MiniMax-M3"],
  ["openai", "gpt-4o-mini"],
  ["gpt", "gpt-4o"],
  ["hive", "deepseek-ai/deepseek-v4.1-flash"],
  ["hive", "zai-org/glm-5.3-flash"],
];

describe("provider swap (T5.4)", () => {
  it("yields an identical plan under every OpenAI-compatible provider name", async () => {
    const plans: string[] = [];
    for (const [provider, model] of OPENAI_COMPATIBLE) {
      const llm = await startFakeLlm([CASES[SAMPLE.id]!.draft]);
      try {
        const res = await generatePlan(request(), { config: config(llm, provider, model) });
        expect(res.status, `${provider}: ${res.message}`).toBe("ok");
        expect(checkWeeklyPlan(res.plan).ok).toBe(true);
        // The adapter must talk to the *configured* host with the configured
        // model and key — that is the whole of the swap contract.
        expect(llm.requests).toHaveLength(1);
        expect(llm.requests[0]!.model).toBe(model);
        expect(llm.requests[0]!.authorization).toContain("fake-key");
        plans.push(stableJson(res.plan));
      } finally {
        await llm.close();
      }
    }
    expect(new Set(plans).size).toBe(1);
  });

  it("selects the non-OpenAI adapter for gemini and fails loudly while it is a stub", async () => {
    // Registry selection is the INV-4 seam and it works for the one provider that
    // is NOT OpenAI-compatible. Implementing that adapter is out of B7's scope
    // (Phase 1 provider = MiniMax, architecture/03), so what B7 pins down is that
    // it is selected and that using it fails loudly instead of silently degrading.
    const gemini = createProvider({ provider: "gemini", apiKey: "k", baseUrl: "https://x", model: "m" });
    expect(gemini.name).toBe("gemini");
    await expect(
      gemini.generateDraft({ systemPrefix: "", userContext: "", draftSchema: {} }),
    ).rejects.toThrow(/not implemented/);
  });

  it("sends MiniMax M3 thinking control only for the disabled experiment arm", async () => {
    const llm = await startFakeLlm([CASES[SAMPLE.id]!.draft, CASES[SAMPLE.id]!.draft]);
    try {
      const base = config(llm, "minimax", "MiniMax-M3");
      const adaptive = createProvider({
        ...base.llm,
        reasoningMode: "adaptive",
        maxCompletionTokens: 8192,
      });
      const disabled = createProvider({
        ...base.llm,
        reasoningMode: "disabled",
        maxCompletionTokens: 8192,
      });
      await adaptive.generateDraft({ systemPrefix: "s", userContext: "u", draftSchema: {} });
      await disabled.generateDraft({ systemPrefix: "s", userContext: "u", draftSchema: {} });

      expect(llm.requests[0]!.thinking).toBeUndefined();
      expect(llm.requests[1]!.thinking).toEqual({ type: "disabled" });
      expect(llm.requests.map((request) => request.max_completion_tokens)).toEqual([8192, 8192]);
    } finally {
      await llm.close();
    }
  });

  it("does not leak MiniMax thinking control to another OpenAI-compatible provider", async () => {
    const llm = await startFakeLlm([CASES[SAMPLE.id]!.draft]);
    try {
      const provider = createProvider({
        ...config(llm, "openai", "gpt-4o-mini").llm,
        reasoningMode: "disabled",
      });
      await provider.generateDraft({ systemPrefix: "s", userContext: "u", draftSchema: {} });
      expect(llm.requests[0]!.thinking).toBeUndefined();
    } finally {
      await llm.close();
    }
  });

  it("rejects an unknown provider name instead of guessing", async () => {
    const llm = await startFakeLlm([CASES[SAMPLE.id]!.draft]);
    try {
      expect(() => createProvider(config(llm, "acme-llm", "m").llm)).toThrow(/Unknown LLM_PROVIDER/);
    } finally {
      await llm.close();
    }
  });

  it("regresses the whole golden set through the adapter, not just the engine", async () => {
    // Same profiles as `golden-set.test.ts`, but the draft now travels through the
    // real SDK + `<think>`/fence stripping, so a parsing regression shows up here.
    for (const item of GOLDEN_PROFILES) {
      const llm = await startFakeLlm([CASES[item.id]!.draft]);
      try {
        const res = await generatePlan(
          {
            ...request(item),
            ...(item.weekNumber ? { week_number: item.weekNumber } : {}),
            prior_logs: item.priorLogs ?? [],
          },
          { config: config(llm, "minimax", "MiniMax-M3") },
        );
        expect(res.status, `${item.id}: ${res.message}`).toBe("ok");
        expect(checkWeeklyPlan(res.plan).ok, item.id).toBe(true);
      } finally {
        await llm.close();
      }
    }
  }, 60_000);

  it("surfaces an upstream failure as an error without a plan", async () => {
    // Every call fails: the SDK retries transport errors on its own, so a
    // first-call-only failure would silently succeed on retry.
    const llm = await startFakeLlm([CASES[SAMPLE.id]!.draft], { failAll: true });
    try {
      const res = await generatePlan(request(), { config: config(llm, "minimax", "MiniMax-M3") });
      expect(res.status).toBe("error");
      expect(res.plan).toBeUndefined();
    } finally {
      await llm.close();
    }
  }, 30_000);
});
