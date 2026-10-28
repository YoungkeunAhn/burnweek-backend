import { describe, expect, it } from "vitest";
import { CANDIDATES, cliCommand, cliJudge, cliProvider, extractJson, generationPrompt, withCandidateTable, type CallLog } from "./eval/cli";
import { judgePair } from "./eval/judge";
import { runEval } from "./eval/run";
import drafts from "./fixtures/golden-drafts.json";
import { EVAL_PROFILES } from "./fixtures/golden-profiles";

// CLI 러너(실행 그래프 N4) — 실제 CLI 는 부르지 않는다. 실측은 N5 스크립트가 한다.

const CASES = (drafts as { cases: Record<string, { draft: unknown }> }).cases;

describe("명령행", () => {
  it("T4-1 claude 는 도구 없이 stdin, codex 는 읽기 전용·마지막 메시지 파일, agy 는 인자", () => {
    const claude = cliCommand(CANDIDATES.claude, "P", "out");
    expect(claude.args).toEqual(expect.arrayContaining(["-p", "--model", "claude-haiku-5-5", "--tools", ""]));
    expect(claude.stdin).toBe("P");
    const codex = cliCommand(CANDIDATES.codex, "P", "out");
    expect(codex.args).toEqual(expect.arrayContaining(["exec", "-s", "read-only", "-o", "out", "model_reasoning_effort=low", "-"]));
    expect(codex.args).not.toContain("--yolo");
    expect(codex.stdin).toBe("P");
    const agy = cliCommand(CANDIDATES.agy, "P", "out");
    expect(agy.args.slice(-2)).toEqual(["-p", "P"]);
    expect(agy.stdin).toBeNull();
    expect(agy.args).toEqual(expect.arrayContaining(["--sandbox", "--mode", "plan"]));
    expect(() => cliCommand(CANDIDATES.agy, "x".repeat(30_001), "out")).toThrow();
  });

  it("T4-2 응답의 서두·코드 펜스를 벗기고 JSON 을 읽는다", () => {
    expect(extractJson('여기 있어요:\n```json\n{"a":1,"b":{"c":2}}\n```')).toEqual({ a: 1, b: { c: 2 } });
    expect(() => extractJson("없음")).toThrow();
  });
});

describe("프롬프트 변형", () => {
  const req = {
    systemPrefix: "SYS",
    userContext: '<profile>{}</profile>\n<available_exercise_ids note="x">\nleg_press pushups nope_id\n</available_exercise_ids>',
    draftSchema: {},
  };

  it("T4-4 P0 는 운영 userContext 를 그대로 싣고, P0+표만 후보 표를 붙인다", () => {
    const p0 = generationPrompt(req, false);
    expect(p0).toContain(req.userContext);
    expect(p0).not.toContain("<candidate_table>");
    const table = withCandidateTable(req.userContext);
    expect(table.startsWith(req.userContext)).toBe(true);
    expect(table).toContain("leg_press | 레그프레스 | machine | quadriceps");
    expect(table).toContain("pushups | 푸시업 | body only | chest");
    expect(table.slice(req.userContext.length)).not.toContain("nope_id");
  });
});

describe("어댑터", () => {
  it("T4-3 CLI provider 가 운영 파이프라인을 통과한다(가짜 실행)", async () => {
    const profile = EVAL_PROFILES[0]!;
    const log: CallLog[] = [];
    const prompts: string[] = [];
    const run = async (_m: unknown, prompt: string) => {
      prompts.push(prompt);
      return `\`\`\`json\n${JSON.stringify(CASES[profile.id]!.draft)}\n\`\`\``;
    };
    const [result] = await runEval({ profiles: [profile], providerFor: () => cliProvider(CANDIDATES.claude, { table: true, log, run }) });
    expect(result!.status).toBe("ok");
    expect(log).toHaveLength(1);
    expect(log[0]!.ok).toBe(true);
    expect(prompts[0]).toContain("<candidate_table>");
  });

  it("CLI 심판도 judgePair 계약을 따른다", async () => {
    const run = async () => '{"winner":"tie"}';
    const result = await judgePair({ week: [] }, { week: [] }, "r", [cliJudge(CANDIDATES.claude, run), cliJudge(CANDIDATES.agy, run)], "ctx");
    expect(result.verdict).toBe("tie");
    expect(result.votes.map((v) => v.judge)).toEqual(["claude", "agy"]);
  });
});
