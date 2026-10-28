/**
 * 1차 실측(실행 그래프 N5) — claude·codex·agy CLI × P0·P0+표 × 평가 프로필, 그리고 MiniMax 녹화본과의 쌍대 심판.
 * **`EVAL_LIVE=1` 일 때만 돈다**(평소 테스트는 건너뜀). 결과는 한 건마다 `EVAL_OUT` JSON 에 쌓고, 이미 있는
 * 키는 건너뛴다 — 시간 예산(`EVAL_BUDGET_MS`)에서 끊고 같은 명령으로 이어 돈다(그래프 X2).
 *   EVAL_LIVE=1 EVAL_PHASE=gen|judge EVAL_OUT=<raw.json> npx vitest run test/model-ab.live.test.ts
 * 2차(N9): EVAL_VARIANTS=p1 로 P1(ADR-0025) 생성, EVAL_JUDGE_MODE=p1_vs_p0 로 같은 모델의 P1 대 P0 심판.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { describe, it } from "vitest";
import { CANDIDATES, JUDGE_MODELS, cliJudge, cliProvider, type CallLog, type CliFamily } from "./eval/cli";
import { judgePair, summarizePlan, type Judge, type PairResult } from "./eval/judge";
import { judgeContext, loadRubric, runEval, type EvalResult } from "./eval/run";
import { buildConfig } from "../src/config";
import { aggregate } from "./eval/aggregate";
import { EVAL_PROFILES } from "./fixtures/golden-profiles";
import goldenDrafts from "./fixtures/golden-drafts.json";

const GOLDEN_CASES = (goldenDrafts as { cases: Record<string, { elapsed_ms?: number }> }).cases;

const LIVE = process.env.EVAL_LIVE === "1";
const OUT = process.env.EVAL_OUT ?? "";
const BUDGET = Number(process.env.EVAL_BUDGET_MS ?? 480_000);
const FAMILIES: CliFamily[] = ["claude", "codex", "agy"];
const ALL_VARIANTS = ["p0", "p0_table", "p1"] as const;
type Variant = (typeof ALL_VARIANTS)[number];
const VARIANTS = (process.env.EVAL_VARIANTS?.split(",") ?? ["p0", "p0_table"]) as Variant[];
/** P1 생성 설정(오프라인 키 — CLI provider 를 주입하므로 키는 쓰이지 않는다). */
const P1_CONFIG = buildConfig({ LLM_API_KEY: "offline", LLM_BASE_URL: "http://offline.invalid", GENERATION_PIPELINE: "p1" });
/** 심판 모드: 후보 P0 대 MiniMax(1차) · 같은 모델 P1 대 P0(2차). */
const JUDGE_MODE = (process.env.EVAL_JUDGE_MODE ?? "p0_vs_minimax") as "p0_vs_minimax" | "p1_vs_p0";
/** 심판을 돌릴 프로필(녹화본이 있는 것 중 대표 6개). */
const JUDGED = [
  "beginner-3day-cardio-none",
  "beginner-4day-upperlower",
  "beginner-bodyweight-only",
  "beginner-home-gym-dumbbells",
  "beginner-minimal-shoulder-injury",
  "week2-progression-pain",
];

interface Raw {
  gens: Record<string, EvalResult & { calls: CallLog[] }>;
  judges: Record<string, PairResult & { candidate: string; baseline: string }>;
  /** 일시 오류로 다시 돈 생성의 이전 실패들. */
  retries?: Record<string, Array<{ message?: string; latencyMs: number }>>;
}

/** 서비스 쪽 일시 오류 — 모델 실력이 아니므로 다음 묶음에서 다시 돈다. */
function transient(message: string | undefined): boolean {
  return /\b503\b|UNAVAILABLE|Eligibility check failed|capacity|시간 초과|ECONNRESET|rate limit/i.test(message ?? "");
}

/** 심판 호출의 일시 오류는 15초 뒤 2번까지 다시 묻는다. */
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

function load(): Raw {
  return existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Raw) : { gens: {}, judges: {} };
}

describe.skipIf(!LIVE)("1차 실측", () => {
  it(
    "chunk",
    async () => {
      if (!OUT) throw new Error("EVAL_OUT 이 필요합니다");
      const raw = load();
      const started = Date.now();
      const save = () => writeFileSync(OUT, JSON.stringify(raw));
      if (process.env.EVAL_PHASE === "export") {
        // 사용자 직접 확인용(10 §3 3) — 프로필마다 MiniMax·세 후보(P0) 플랜 요약과 심판 표.
        const golden = await runEval({ profiles: EVAL_PROFILES });
        const view = EVAL_PROFILES.map((p) => ({
          id: p.id,
          why: p.why,
          context: judgeContext(p),
          plans: Object.fromEntries([
            ["minimax", golden.find((g) => g.profileId === p.id)?.plan],
            ...FAMILIES.map((f) => [f, raw.gens[`${p.id}|${f}|p0`]?.plan]),
            ...FAMILIES.map((f) => [`${f}:p1`, raw.gens[`${p.id}|${f}|p1`]?.plan]),
          ].filter(([, plan]) => plan).map(([name, plan]) => [name, summarizePlan(plan)])),
          judges: Object.fromEntries(
            FAMILIES.flatMap((f) => [
              [f, raw.judges[`${p.id}|${f}|p0_vs_minimax`]],
              [`${f}:p1_vs_p0`, raw.judges[`${p.id}|${f}|p1_vs_p0`]],
            ]).filter(([, j]) => j),
          ),
        }));
        writeFileSync(process.env.EVAL_RESULT ?? "", JSON.stringify(view));
        return;
      }
      if (process.env.EVAL_PHASE === "summary") {
        const golden = await runEval({ profiles: EVAL_PROFILES });
        const summary = summarize(raw, golden);
        writeFileSync(process.env.EVAL_RESULT ?? "", JSON.stringify(summary, null, 2) + "\n");
        console.log(JSON.stringify(summary.byModel, null, 1));
        console.log(JSON.stringify(summary.judgeTally, null, 1));
        return;
      }
      if (process.env.EVAL_PHASE !== "judge") {
        const only = process.env.EVAL_ONLY?.split(",");
        for (const profile of EVAL_PROFILES.filter((p) => !only || only.includes(p.id))) {
          for (const family of FAMILIES) {
            for (const variant of VARIANTS) {
              const key = `${profile.id}|${family}|${variant}`;
              if (raw.gens[key] && !transient(raw.gens[key]!.message)) continue;
              if (Date.now() - started > BUDGET) return;
              const calls: CallLog[] = [];
              const [result] = await runEval({
                profiles: [profile],
                providerFor: () => cliProvider(CANDIDATES[family], { table: variant === "p0_table", log: calls }),
                ...(variant === "p1" ? { config: P1_CONFIG } : {}),
              });
              // 일시 오류로 다시 돈 키는 이전 실패를 지우지 않고 이력에 남긴다(codex N5 R1).
              const previous = raw.gens[key];
              if (previous) (raw.retries ??= {})[key] = [...(raw.retries[key] ?? []), { message: previous.message, latencyMs: previous.latencyMs }];
              raw.gens[key] = { ...result!, calls };
              save();
              console.log(key, result!.status, result!.latencyMs, result!.message?.slice(0, 120) ?? "");
            }
          }
        }
        return;
      }
      const rubric = loadRubric();
      for (const id of JUDGED) {
        const profile = EVAL_PROFILES.find((p) => p.id === id)!;
        const [golden] = await runEval({ profiles: [profile] });
        for (const family of FAMILIES) {
          const key = `${id}|${family}|${JUDGE_MODE}`;
          if (raw.judges[key]) continue;
          const p1 = JUDGE_MODE === "p1_vs_p0";
          const candidate = raw.gens[`${id}|${family}|${p1 ? "p1" : "p0"}`];
          const baseline = p1 ? raw.gens[`${id}|${family}|p0`]?.plan : golden?.plan;
          if (!candidate?.plan || !baseline) continue;
          if (Date.now() - started > BUDGET) return;
          // 후보와 다른 두 계열이 심판(09 §5 2 · G0 Q5). 기준선 MiniMax 는 어느 심판 계열도 아니고,
          // P1 대 P0 는 같은 모델이라 그 계열을 빼면 된다.
          const judges = FAMILIES.filter((f) => f !== family).map((f) => retrying(cliJudge(JUDGE_MODELS[f])));
          const result = await judgePair(candidate.plan, baseline, rubric, judges, judgeContext(profile));
          raw.judges[key] = { ...result, candidate: `${family}:${p1 ? "p1" : "p0"}`, baseline: p1 ? `${family}:p0` : "minimax:golden" };
          save();
          console.log(key, result.verdict, JSON.stringify(result.votes));
        }
      }
    },
    3_600_000,
  );
});

// ── 요약(결과 JSON 은 지표만 — 플랜 원문은 스크래치에 남긴다) ─────────────────────

function summarize(raw: Raw, golden: EvalResult[]) {
  const byModel: Record<string, ReturnType<typeof aggregate>> = {
    // 지연은 녹화 당시 운영 호출 시간(`golden-drafts.json` elapsed_ms) — 오프라인 재생 시간이 아니다.
    "minimax:golden(12)": aggregate(
      golden.filter((r) => r.status === "ok"),
      Object.values(GOLDEN_CASES).map((c) => ({ family: "claude" as CliFamily, ms: c.elapsed_ms ?? 0, promptBytes: 0, ok: c.elapsed_ms !== undefined })),
    ),
  };
  for (const family of FAMILIES) {
    for (const variant of ALL_VARIANTS) {
      const rows = Object.entries(raw.gens).filter(([k]) => k.endsWith(`|${family}|${variant}`)).map(([, v]) => v);
      byModel[`${family}:${CANDIDATES[family].model}:${variant}`] = aggregate(rows, rows.flatMap((r) => r.calls));
      // 녹화본과 같은 12 프로필만 따로(공정 비교).
      const twelve = rows.filter((r) => golden.some((g) => g.profileId === r.profileId && g.status === "ok"));
      byModel[`${family}:${variant}(12)`] = aggregate(twelve, twelve.flatMap((r) => r.calls));
    }
  }
  const judgeTally: Record<string, { A: number; B: number; tie: number; votes: Record<string, string> }> = {};
  for (const [key, j] of Object.entries(raw.judges)) {
    // 1차 키는 `가족`, 2차(P1 대 P0)는 `가족|p1_vs_p0` 로 센다.
    const [, fam, mode] = key.split("|");
    const family = mode === "p0_vs_minimax" ? fam! : `${fam}|${mode}`;
    const t = (judgeTally[family] ??= { A: 0, B: 0, tie: 0, votes: {} });
    t[j.verdict] += 1;
    t.votes[key.split("|")[0]!] = j.votes.map((v) => `${v.judge}:${v.forward ?? "-"}${v.reversed ?? "-"}`).join(" ");
  }
  return {
    date: "2026-10-14",
    note: "judgeTally: `가족` = 후보 P0(A) 대 MiniMax-M3 녹화본(B) · `가족|p1_vs_p0` = 같은 모델 P1(A) 대 P0(B). 심판은 후보와 다른 두 계열, 순서 교차, 둘 다 같을 때만 승패. 지연은 CLI 기동 포함.",
    candidates: CANDIDATES,
    judges: JUDGE_MODELS,
    byModel,
    judgeTally,
    retries: raw.retries ?? {},
  };
}
