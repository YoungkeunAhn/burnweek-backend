/**
 * 3차 실측(실행 그래프 N10c · D105) — Hive DeepSeek·GLM × 운영 라우팅(auto: 헬스장 P1 · 그 밖 P0) × 평가 프로필.
 * 기준선은 2차의 claude haiku 같은 라우팅(헬스장 p1 · 그 밖 p0) 플랜이다(07 §4.3 3). 심판은 후보·기준선 어느 쪽도
 * 아닌 두 계열(codex · agy). DeepSeek 대 GLM 맞대결도 같은 심판으로 본다.
 * **`HIVE_LIVE=1` 일 때만 돈다.** 키는 `backend/.env.local` 의 `HIVE_API_KEY`(출력하지 않는다).
 *   HIVE_LIVE=1 EVAL_PHASE=gen|judge|summary EVAL_OUT=<raw.json> EVAL_BASE=<2차 raw.json> npx vitest run test/hive-ab.live.test.ts
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { buildConfig, pipelineFor } from "../src/config";
import { createProvider, type LLMProvider } from "../src/llm";
import { aggregate } from "./eval/aggregate";
import { JUDGE_MODELS, cliJudge } from "./eval/cli";
import { judgePair, type Judge, type PairResult } from "./eval/judge";
import { judgeContext, loadRubric, runEval, type EvalResult } from "./eval/run";
import { EVAL_PROFILES } from "./fixtures/golden-profiles";

const LIVE = process.env.HIVE_LIVE === "1";
const OUT = process.env.EVAL_OUT ?? "";
const BUDGET = Number(process.env.EVAL_BUDGET_MS ?? 480_000);
const BASE_URL = "https://api.thehive.ai/api/v3";
const MODELS = { deepseek: "deepseek-ai/deepseek-v4.1-flash", glm: "zai-org/glm-5.3-flash" } as const;
type Hive = keyof typeof MODELS;
const JUDGED = [
  "beginner-3day-cardio-none",
  "beginner-4day-upperlower",
  "beginner-bodyweight-only",
  "beginner-home-gym-dumbbells",
  "beginner-minimal-shoulder-injury",
  "week2-progression-pain",
];

interface Call { ms: number; ok: boolean; tokens?: number; reasoningTokens?: number }
interface Raw {
  gens: Record<string, EvalResult & { calls: Call[] }>;
  judges: Record<string, PairResult & { a: string; b: string }>;
}

/** 이 워크트리의 `.env.local` 이 먼저, 없으면 `HIVE_ENV_FILE`(메인 경로 등). */
function hiveKey(): string {
  for (const f of [".env.local", process.env.HIVE_ENV_FILE ?? ""]) {
    if (!f || !existsSync(f)) continue;
    const m = readFileSync(f, "utf8").match(/^HIVE_API_KEY=(.*)$/m);
    if (m?.[1]?.trim()) return m[1].trim().replace(/^["']|["']$/g, "");
  }
  throw new Error("HIVE_API_KEY 가 backend/.env.local 에 없습니다");
}

/** 호출마다 지연·토큰을 남긴다. 추론 토큰은 Hive 가 usage 에 따로 싣는다(07 §4.3). */
function logged(inner: LLMProvider, calls: Call[]): LLMProvider {
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    async generateDraft(req) {
      const started = Date.now();
      try {
        const out = await inner.generateDraft(req);
        const u = (out.raw as { usage?: { reasoning_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } } | undefined)?.usage;
        calls.push({
          ms: Date.now() - started,
          ok: true,
          tokens: out.usage?.totalTokens,
          reasoningTokens: u?.reasoning_tokens ?? u?.completion_tokens_details?.reasoning_tokens,
        });
        return out;
      } catch (err) {
        calls.push({ ms: Date.now() - started, ok: false });
        throw err;
      }
    },
  };
}

function transient(message: string | undefined): boolean {
  return /\b(429|5\d\d)\b|ECONNRESET|timeout|rate limit|UNAVAILABLE|capacity|시간 초과/i.test(message ?? "");
}

function retrying(judge: Judge): Judge {
  return {
    name: judge.name,
    async ask(prompt) {
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await judge.ask(prompt);
        } catch (err) {
          if (attempt >= 2 || !transient(String(err))) throw err;
          await new Promise((r) => setTimeout(r, 15_000));
        }
      }
    },
  };
}

type BaseGen = EvalResult & { calls?: Array<{ ms: number; ok: boolean }> };

/** 2차 원자료에서 claude haiku 의 운영 라우팅 플랜. */
function baselineGen(base: { gens: Record<string, BaseGen> }, id: string): BaseGen | undefined {
  const profile = EVAL_PROFILES.find((p) => p.id === id)!;
  return base.gens[`${id}|claude|${pipelineFor("auto", profile.profile.environment)}`];
}

const avg = (v: number[]) => (v.length === 0 ? null : Math.round(v.reduce((a, b) => a + b, 0) / v.length));

describe.skipIf(!LIVE)("3차 실측(Hive)", () => {
  it(
    "chunk",
    async () => {
      if (!OUT) throw new Error("EVAL_OUT 이 필요합니다");
      const raw: Raw = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf8")) : { gens: {}, judges: {} };
      const base = JSON.parse(readFileSync(process.env.EVAL_BASE ?? "", "utf8")) as { gens: Record<string, BaseGen> };
      const save = () => writeFileSync(OUT, JSON.stringify(raw));
      const started = Date.now();
      const phase = process.env.EVAL_PHASE ?? "gen";

      if (phase === "gen") {
        const key = hiveKey();
        const only = process.env.EVAL_ONLY?.split(",");
        for (const profile of EVAL_PROFILES.filter((p) => !only || only.includes(p.id))) {
          for (const hive of Object.keys(MODELS) as Hive[]) {
            const k = `${profile.id}|${hive}|auto`;
            if (raw.gens[k] && !transient(raw.gens[k]!.message)) continue;
            if (Date.now() - started > BUDGET) return;
            const config = buildConfig({ LLM_PROVIDER: "hive", LLM_API_KEY: key, LLM_BASE_URL: BASE_URL, LLM_MODEL: MODELS[hive] });
            const calls: Call[] = [];
            const [result] = await runEval({ profiles: [profile], config, providerFor: () => logged(createProvider(config.llm), calls) });
            raw.gens[k] = { ...result!, calls };
            save();
            console.log(k, result!.status, result!.latencyMs, result!.message?.slice(0, 120) ?? "");
          }
        }
        return;
      }

      if (phase === "judge") {
        const rubric = loadRubric();
        // 후보(DeepSeek·GLM)도 기준선(claude)도 아닌 두 계열.
        const judges = [retrying(cliJudge(JUDGE_MODELS.codex)), retrying(cliJudge(JUDGE_MODELS.agy))];
        for (const id of JUDGED) {
          const profile = EVAL_PROFILES.find((p) => p.id === id)!;
          const claude = baselineGen(base, id)?.plan;
          const ds = raw.gens[`${id}|deepseek|auto`]?.plan;
          const glm = raw.gens[`${id}|glm|auto`]?.plan;
          const pairs: Array<[string, unknown, string, unknown]> = [
            ["deepseek", ds, "claude", claude],
            ["glm", glm, "claude", claude],
            ["deepseek", ds, "glm", glm],
          ];
          for (const [a, planA, b, planB] of pairs) {
            const k = `${id}|${a}_vs_${b}`;
            if (raw.judges[k] || !planA || !planB) continue;
            if (Date.now() - started > BUDGET) return;
            const result = await judgePair(planA, planB, rubric, judges, judgeContext(profile));
            raw.judges[k] = { ...result, a, b };
            save();
            console.log(k, result.verdict, JSON.stringify(result.votes));
          }
        }
        return;
      }

      // summary — 지표만(플랜 원문은 스크래치).
      const byModel: Record<string, unknown> = {};
      for (const hive of Object.keys(MODELS) as Hive[]) {
        const rows = Object.entries(raw.gens).filter(([k]) => k.endsWith(`|${hive}|auto`)).map(([, v]) => v);
        const calls = rows.flatMap((r) => r.calls);
        byModel[`hive:${MODELS[hive]}:auto`] = {
          ...aggregate(rows, calls),
          llm_calls: calls.length,
          tokens_per_call_mean: avg(calls.flatMap((c) => (c.tokens ? [c.tokens] : []))),
          reasoning_tokens_per_call_mean: avg(calls.flatMap((c) => (c.reasoningTokens ? [c.reasoningTokens] : []))),
          failures: rows.filter((r) => r.status !== "ok").map((r) => `${r.profileId}: ${r.status} ${r.message?.slice(0, 100) ?? ""}`),
        };
      }
      const claudeRows = EVAL_PROFILES.map((p) => baselineGen(base, p.id)).filter((r): r is BaseGen => !!r);
      byModel["claude:claude-haiku-5-5:auto(2차)"] = aggregate(claudeRows, claudeRows.flatMap((r) => r.calls ?? []));
      const judgeTally: Record<string, { A: number; B: number; tie: number; votes: Record<string, string> }> = {};
      for (const [k, j] of Object.entries(raw.judges)) {
        const [id, pair] = k.split("|");
        const t = (judgeTally[pair!] ??= { A: 0, B: 0, tie: 0, votes: {} });
        t[j.verdict] += 1;
        t.votes[id!] = j.votes.map((v) => `${v.judge}:${v.forward ?? "-"}${v.reversed ?? "-"}`).join(" ");
      }
      const summary = {
        date: "2026-10-16",
        note: "Hive 두 모델 × 운영 라우팅(auto: 헬스장 p1 · 그 밖 p0). judgeTally `a_vs_b` 에서 A=a 승 · B=b 승. 심판 codex·agy, 순서 교차, 둘 다 같을 때만 승패. 기준선 claude haiku 는 2차(2026-10-15) 원자료. 지연은 Hive API 왕복(CLI 기동 없음)이라 2차 CLI 지연과 직접 비교하지 않는다.",
        judges: { codex: JUDGE_MODELS.codex, agy: JUDGE_MODELS.agy },
        byModel,
        judgeTally,
      };
      writeFileSync(process.env.EVAL_RESULT ?? "", JSON.stringify(summary, null, 2) + "\n");
      console.log(JSON.stringify(byModel, null, 1));
      console.log(JSON.stringify(judgeTally, null, 1));
    },
    3_600_000,
  );
});
