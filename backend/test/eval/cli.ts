/**
 * 실측 전용 CLI 러너(실행 그래프 N4) — claude·codex·agy 를 `LLMProvider`(플랜 생성)와 `Judge`(심판)로 감싼다.
 * API 키 대신 각 CLI 의 로그인 세션을 쓴다(사용자 2026-10-14). 운영 경로는 이 파일을 읽지 않는다(INV-3·4).
 *
 * - claude: stdin 프롬프트 · 도구 없음(`--tools ""`).
 * - codex: stdin 프롬프트 · 읽기 전용 샌드박스 · 마지막 메시지를 파일로(`-o`). ChatGPT 계정은 기본 모델만 된다.
 *   셸 도구 자체를 끄는 플래그는 없다 — 읽기 전용 + 빈 폴더가 격리의 전부다.
 * - agy: 인자 프롬프트만 받는다(stdin 불가 · 약 30KB 상한). 샌드박스 + plan 모드(편집 없음).
 * 모두 빈 작업 폴더에서 돌린다 — 리포를 읽으며 헤매지 않게.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { byId } from "../../src/data/exercises";
import type { DraftRequest, LLMProvider } from "../../src/llm/types";
import type { Judge } from "./judge";

export type CliFamily = "claude" | "codex" | "agy";

export interface CliModel {
  family: CliFamily;
  /** 생성 후보 모델(07 의 후보에 가장 가까운 것). */
  model: string;
}

/** 생성 후보 — 07 §1 후보 중 각 CLI 로 부를 수 있는 것. */
export const CANDIDATES: Record<CliFamily, CliModel> = {
  claude: { family: "claude", model: "claude-haiku-5-5" },
  codex: { family: "codex", model: "default@low" },
  agy: { family: "agy", model: "gemini-3.8-flash-low" },
};

/** 심판 — 각 계열의 상위 설정. */
export const JUDGE_MODELS: Record<CliFamily, CliModel> = {
  claude: { family: "claude", model: "claude-sonnet-5-5" },
  codex: { family: "codex", model: "default@medium" },
  agy: { family: "agy", model: "gemini-3.8-flash-high" },
};

const AGY_ARG_LIMIT = 30_000;

/** CLI 별 명령행 — 순수함수라 테스트가 본다(T4-1). */
export function cliCommand(m: CliModel, prompt: string, outFile: string): { cmd: string; args: string[]; stdin: string | null; shell: boolean } {
  switch (m.family) {
    case "claude":
      return {
        cmd: "claude",
        args: ["-p", "--model", m.model, "--tools", "", "--no-session-persistence", "--output-format", "text"],
        stdin: prompt,
        shell: false,
      };
    case "codex": {
      const effort = m.model.split("@")[1] ?? "medium";
      return {
        cmd: "codex",
        args: ["exec", "-c", `model_reasoning_effort=${effort}`, "-s", "read-only", "--color", "never", "--skip-git-repo-check", "-o", outFile, "-"],
        stdin: prompt,
        // npm 셈(codex.cmd)은 셸 없이 못 띄운다 — 인자에 프롬프트가 없어 셸 인용 문제가 없다.
        shell: true,
      };
    }
    case "agy":
      if (Buffer.byteLength(prompt, "utf8") > AGY_ARG_LIMIT) throw new Error(`agy 프롬프트가 ${AGY_ARG_LIMIT}바이트를 넘습니다`);
      return {
        cmd: "agy",
        args: ["--sandbox", "--mode", "plan", "--output-format", "text", "--model", m.model, "-p", prompt],
        stdin: null,
        shell: false,
      };
  }
}

export async function runCli(m: CliModel, prompt: string, timeoutMs = 300_000): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "eval-cli-"));
  const outFile = join(dir, "last.txt");
  try {
    const { cmd, args, stdin, shell } = cliCommand(m, prompt, outFile);
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(cmd, args, { cwd: dir, shell, windowsHide: true });
      let out = "";
      let err = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error(`${m.family} 시간 초과(${timeoutMs}ms)`));
      }, timeoutMs);
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`${m.family} 종료 ${code}: ${(err || out).slice(-400)}`));
      });
      if (stdin !== null) child.stdin.end(stdin);
      else child.stdin.end();
    });
    return m.family === "codex" ? readFileSync(outFile, "utf8") : stdout;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 응답 속 첫 `{` 부터 마지막 `}` 까지를 JSON 으로 읽는다(코드 펜스·서두 허용). */
export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error(`JSON 없음: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * 「P0+표」 변형(09 §5 3) — `<available_exercise_ids>` 의 id 마다 한글명·장비·주근육·복합/고립·난이도·요구 도구를
 * 붙인 표를 덧붙인다. 운영 프롬프트(`prompt.ts`)는 그대로 두고 실측 쪽에서만 만든다(T4-4).
 */
export function withCandidateTable(userContext: string): string {
  const block = /<available_exercise_ids[^>]*>([\s\S]*?)<\/available_exercise_ids>/.exec(userContext);
  if (!block) return userContext;
  const ids = block[1]!.split(/[\s,]+/).filter((id) => byId(id) !== undefined);
  const rows = ids.map((id) => {
    const e = byId(id)!;
    return `${id} | ${e.name_ko} | ${e.equipment} | ${e.primary_muscles.join("/")} | ${e.mechanic ?? "-"} | ${e.level} | ${(e.requires ?? []).join("+") || "-"}`;
  });
  return `${userContext}\n<candidate_table>\nid | 한글명 | 장비 | 주근육 | 복합/고립 | 난이도 | 요구 도구\n${rows.join("\n")}\n</candidate_table>`;
}

export function generationPrompt(req: DraftRequest, table: boolean): string {
  return [
    req.systemPrefix,
    "",
    table ? withCandidateTable(req.userContext) : req.userContext,
    req.repairFeedback ? `\n<repair>\n${req.repairFeedback}\n</repair>` : "",
    "",
    // P1(ADR-0025)은 SlotDraft 를 낸다. P0 문구는 1차 실측과 바이트 동일하게 둔다.
    `Do not use any tools. Output only the ${req.systemPrefix.includes("<slot_draft_schema>") ? "SlotDraft" : "DraftPlan"} JSON object.`,
  ].join("\n");
}

export interface CallLog {
  family: CliFamily;
  ms: number;
  promptBytes: number;
  ok: boolean;
}

export function cliProvider(m: CliModel, opts: { table: boolean; log?: CallLog[]; run?: typeof runCli }): LLMProvider {
  const run = opts.run ?? runCli;
  return {
    name: `cli-${m.family}`,
    capabilities: { streaming: false, jsonSchema: false },
    async generateDraft(req) {
      const prompt = generationPrompt(req, opts.table);
      const started = Date.now();
      try {
        const text = await run(m, prompt);
        const draft = extractJson(text);
        opts.log?.push({ family: m.family, ms: Date.now() - started, promptBytes: Buffer.byteLength(prompt), ok: true });
        return { draft, model: `${m.family}:${m.model}` };
      } catch (err) {
        opts.log?.push({ family: m.family, ms: Date.now() - started, promptBytes: Buffer.byteLength(prompt), ok: false });
        throw err;
      }
    },
  };
}

export function cliJudge(m: CliModel, run: typeof runCli = runCli): Judge {
  return { name: m.family, ask: (prompt) => run(m, prompt) };
}
