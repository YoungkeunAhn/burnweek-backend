/**
 * 평가 실행기 — 프로필마다 운영과 같은 `generatePlan` 파이프라인을 돌리고 하드 지표를 잰다.
 * **기본은 오프라인**이다: provider 를 주지 않으면 커밋된 골든 드래프트를 돌려주는 가짜를 쓴다(T3-4).
 * 실측(N5·N9)은 claude·codex·agy CLI provider 를 주입해서만 돈다.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { generatePlan } from "../../src/generation/handler";
import { buildConfig, type AppConfig } from "../../src/config";
import type { DraftRequest, LLMProvider } from "../../src/llm/types";
import drafts from "../fixtures/golden-drafts.json";
import type { EvalProfile } from "../fixtures/golden-profiles";
import { byId } from "../../src/data/exercises";
import { evaluatePlan, type PlanMetrics } from "./evaluate";

/** 골든 픽스처의 주 시작일(월요일) — `weekProfile` 이 주 전체를 남기도록 그 날 아침을 「오늘」로 둔다. */
export const EVAL_WEEK_START = "2026-08-17";
const EVAL_NOW = Date.parse(`${EVAL_WEEK_START}T00:00:00+09:00`);

/** 자리표시 키 — provider 를 주입하므로 설정의 LLM 값은 쓰이지 않는다(네트워크 없음). */
const OFFLINE_CONFIG: AppConfig = buildConfig({ LLM_API_KEY: "offline", LLM_BASE_URL: "http://offline.invalid", GENERATION_PIPELINE: "p0" }); // 골든 드래프트는 P0 모양

const CASES = (drafts as { cases: Record<string, { draft: unknown }> }).cases;

/** 커밋된 골든 드래프트를 돌려준다. 없는 프로필은 실패(평가 결과에 error 로 남는다). */
export function goldenProvider(profile: EvalProfile): LLMProvider {
  return {
    name: "golden",
    capabilities: { streaming: false, jsonSchema: false },
    async generateDraft(_req: DraftRequest) {
      const fixture = CASES[profile.id];
      if (!fixture) throw new Error(`골든 드래프트 없음: ${profile.id}`);
      return { draft: fixture.draft, model: "golden" };
    },
  };
}

export interface EvalResult {
  profileId: string;
  status: string;
  latencyMs: number;
  llmCalls?: number;
  message?: string;
  plan?: unknown;
  metrics?: PlanMetrics;
}

export async function runEval(opts: {
  profiles: EvalProfile[];
  providerFor?: (profile: EvalProfile) => LLMProvider;
  config?: AppConfig;
}): Promise<EvalResult[]> {
  const providerFor = opts.providerFor ?? goldenProvider;
  const results: EvalResult[] = [];
  for (const item of opts.profiles) {
    const started = Date.now();
    let response;
    try {
      response = await generatePlan(
        {
          user_id: `eval-${item.id}`,
          week_start_date: EVAL_WEEK_START,
          week_number: item.weekNumber ?? 1,
          profile: item.profile,
          prior_logs: item.priorLogs ?? [],
          // 앱은 직전 주 종목 id 를 연속성 신호로 같이 보낸다 — 기록에서 뽑는다.
          recent_exercise_ids: recentIds(item.priorLogs ?? []),
          supports_circuits: true, // 실측은 새 번들 기준(N10d)
        },
        { config: opts.config ?? OFFLINE_CONFIG, provider: providerFor(item), now: EVAL_NOW },
      );
    } catch (err) {
      results.push({ profileId: item.id, status: "error", latencyMs: Date.now() - started, message: (err as Error).message });
      continue;
    }
    results.push({
      profileId: item.id,
      status: response.status,
      latencyMs: Date.now() - started,
      llmCalls: response.telemetry?.llmCalls,
      message: response.message,
      plan: response.plan,
      metrics: response.plan === undefined ? undefined : evaluatePlan(response.plan, item.profile),
    });
  }
  return results;
}

function recentIds(priorLogs: unknown[]): string[] {
  const ids = (priorLogs as Array<{ exercises?: Array<{ exercise_id?: unknown }> }>).flatMap((s) =>
    (s.exercises ?? []).map((e) => e.exercise_id).filter((id): id is string => typeof id === "string"),
  );
  return [...new Set(ids)];
}

/** 기준표 10 의 ```rubric 블록 — 심판 프롬프트의 단일 원천. */
export function loadRubric(): string {
  const path = fileURLToPath(
    new URL("../../../miniapp/backlogs/운동목록_및_운동플랜_개선/10-judgment-rubric.md", import.meta.url),
  );
  const match = /```rubric\r?\n([\s\S]*?)```/.exec(readFileSync(path, "utf8"));
  if (!match) throw new Error("기준표 10 에 ```rubric 블록이 없습니다");
  return match[1]!.trim();
}

/** 심판에게 줄 사용자 맥락 — 프로필 요지 + 좋은 플랜 조건. 수치 처방은 넣지 않는다. */
export function judgeContext(item: EvalProfile): string {
  const p = item.profile;
  return [
    `goals=${p.goals.join(",")} level=${p.experience_level} days=${p.days_per_week} session=${p.session_len_min}min`,
    `environment=${p.environment} equipment=${p.equipment.join(",") || "(none)"} cardio=${p.cardio_pref}`,
    `injuries=${p.injuries.map((i) => i.region).join(",") || "(none)"} focus=${p.focus_area ?? "balanced"} week=${item.weekNumber ?? 1}`,
    `last week performed: ${priorSummary(item.priorLogs ?? []) || "(none)"}`,
    `good plan conditions: ${item.goodPlan.join(" / ") || "(none)"}`,
  ].join("\n");
}

/** 지난주 수행 요약 — 이력 반영·연속성을 심판이 실제 기록으로 보게 한다(codex N3 R1). */
function priorSummary(priorLogs: unknown[]): string {
  type Log = {
    exercises?: Array<{ exercise_id?: unknown; sets?: Array<{ set_kind?: unknown; actual_reps?: unknown; pain_flag?: unknown; failed?: unknown }> }>;
  };
  return (priorLogs as Log[])
    .flatMap((s) => s.exercises ?? [])
    .map((e) => {
      const id = typeof e.exercise_id === "string" ? e.exercise_id : "?";
      const working = (e.sets ?? []).filter((s) => s.set_kind === "working");
      const flags = working.some((s) => s.pain_flag === true) ? " pain" : working.some((s) => s.failed === true) ? " failed" : "";
      return `${byId(id)?.name_ko ?? id}(${id}) reps ${working.map((s) => s.actual_reps).join("/")}${flags}`;
    })
    .join("; ");
}
