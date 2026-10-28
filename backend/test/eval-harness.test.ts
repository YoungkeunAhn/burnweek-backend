import { describe, expect, it } from "vitest";
import { evaluatePlan } from "./eval/evaluate";
import { judgePair, parseWinner, type Judge } from "./eval/judge";
import { judgeContext, loadRubric, runEval } from "./eval/run";
import { EVAL_PROFILES, GOLDEN_PROFILES } from "./fixtures/golden-profiles";
import type { UserProfile } from "../src/generation/types";

// 평가 하네스(실행 그래프 N3 · 백로그 운동목록_및_운동플랜_개선/09 §5 · 10).

function profile(overrides: Partial<UserProfile>): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 3,
    session_len_min: 45,
    environment: "full_gym",
    equipment: ["barbell", "dumbbell", "cable", "machine", "body only"],
    cardio_pref: "maintain_health",
    cardio_modalities: [],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}

/** 지표만 읽는 최소 플랜 — 운동마다 워킹 세트 n개(+ 워밍업 w개). */
function plan(rows: Array<[id: string, working: number, warmup?: number]>) {
  return {
    week: [
      {
        day_index: 0,
        exercises: rows.map(([id, working, warmup = 0]) => ({
          exercise_id: id,
          modality: "strength",
          sets: [
            ...Array.from({ length: warmup }, () => ({ set_kind: "warmup" })),
            ...Array.from({ length: working }, () => ({ set_kind: "working" })),
          ],
        })),
      },
    ],
  };
}

describe("하드 지표", () => {
  it("T3-1 도구 위반을 requires 로 센다(01 §2.1 u9038 형태)", () => {
    const u9038 = plan([
      ["pullups", 4],
      ["wide_grip_rear_pull_up", 3],
      ["chin_up", 3],
      ["v_bar_pullup", 3],
      ["dips_triceps_version", 3],
      ["bench_dips", 3],
      ["hyperextensions_with_no_hyperextension_bench", 3],
      ["pushups", 3],
      ["bodyweight_squat", 3],
    ]);
    const bodyweight = profile({ environment: "bodyweight_only", equipment: [] });
    expect(evaluatePlan(u9038, bodyweight).toolViolations).toHaveLength(7);
    // 철봉이 있으면 풀업 4종은 위반이 아니다.
    expect(evaluatePlan(u9038, profile({ environment: "bodyweight_only", equipment: ["pull_up_bar"] })).toolViolations).toEqual([
      "dips_triceps_version",
      "bench_dips",
      "hyperextensions_with_no_hyperextension_bench",
    ]);
  });

  it("T3-2 근육별 주간 세트 — 주근육 1 · 보조 0.5, 워밍업 제외(01 §2.3 u5076 형태)", () => {
    const u5076 = plan([
      ["barbell_bench_press_medium_grip", 4, 2],
      ["leverage_chest_press", 4],
      ["leg_press", 4],
      ["seated_cable_rows", 3],
      ["wide_grip_lat_pulldown", 3],
    ]);
    const m = evaluatePlan(u5076, profile({}));
    expect(m.setsByMuscle.chest).toBe(8);
    expect(m.setsByMuscle.quadriceps).toBe(4);
    expect(m.setsByMuscle.triceps).toBe(4);
    expect(m.setsByMuscle.hamstrings).toBe(2);
    expect(m.setsByMuscle["middle back"]).toBe(4.5);
    expect(m.pushSets).toBe(8);
    expect(m.pullSets).toBe(6);
    expect(m.pushPullRatio).toBeCloseTo(8 / 6);
    expect(m.basicRatio).toBeCloseTo(4 / 5);
  });

  it("금기 위반 — 어깨 부상에 어깨를 쓰는 운동", () => {
    const m = evaluatePlan(plan([["leg_press", 3], ["machine_shoulder_military_press", 3]]), profile({ injuries: [{ region: "shoulders" }] }));
    expect(m.contraindicationViolations).toContain("machine_shoulder_military_press");
    expect(m.contraindicationViolations).not.toContain("leg_press");
  });

  it("안전 지표는 유산소 줄도 본다 — 볼륨·비율에는 안 넣는다", () => {
    const withCardio = {
      week: [{ exercises: [{ exercise_id: "pullups", modality: "cardio", sets: [{ set_kind: "working" }] }] }],
    };
    const m = evaluatePlan(withCardio, profile({ environment: "bodyweight_only", equipment: [] }));
    expect(m.toolViolations).toEqual(["pullups"]);
    expect(m.exerciseCount).toBe(0);
  });
});

const fixed = (name: string, answer: (prompt: string) => string): Judge => ({ name, ask: async (p) => answer(p) });
const A = plan([["leg_press", 3]]);
const B = plan([["barbell_squat", 3]]);
/** 레그프레스 플랜이 어느 칸에 있든 그쪽을 고르는 일관된 심판. */
const prefersA = (name: string) =>
  fixed(name, (p) => (p.indexOf("레그프레스") < p.indexOf("바벨 스쿼트") ? '{"winner":"plan_1"}' : '{"winner":"plan_2"}'));

describe("심판", () => {
  it("T3-3 앞 순서만 고르는 심판은 순서 교차로 무승부가 된다", async () => {
    const first = (name: string) => fixed(name, () => '{"winner":"plan_1","reason":"x"}');
    const result = await judgePair(A, B, "r", [first("claude"), first("codex")], "ctx");
    expect(result.verdict).toBe("tie");
    expect(result.votes.map((v) => [v.forward, v.reversed])).toEqual([["A", "B"], ["A", "B"]]);
  });

  it("일관된 두 심판이 같으면 채택, 하나라도 다르면 무승부", async () => {
    expect((await judgePair(A, B, "r", [prefersA("claude"), prefersA("codex")], "ctx")).verdict).toBe("A");
    const tieJudge = fixed("agy", () => '{"winner":"tie"}');
    expect((await judgePair(A, B, "r", [prefersA("claude"), tieJudge], "ctx")).verdict).toBe("tie");
  });

  it("같은 계열 둘은 심판 2개가 아니다(G0 Q5)", async () => {
    await expect(judgePair(A, B, "r", [prefersA("claude"), prefersA("claude")], "ctx")).rejects.toThrow();
  });

  it("응답의 마지막 winner 를 읽고, 없으면 null", () => {
    expect(parseWinner('생각... {"winner":"plan_1"} 정정: {"winner":"plan_2"}')).toBe("plan_2");
    expect(parseWinner("모르겠다")).toBeNull();
  });
});

describe("실행기", () => {
  it("T3-4 키 없이 오프라인으로 돈다 — 기본 provider 는 골든 드래프트", async () => {
    const bodyweight = GOLDEN_PROFILES.find((p) => p.id === "beginner-bodyweight-only")!;
    const [result] = await runEval({ profiles: [{ ...bodyweight, goodPlan: [] }] });
    expect(result!.status).toBe("ok");
    expect(result!.metrics!.schemaOk).toBe(true);
    expect(result!.metrics!.toolViolations).toEqual([]);
  });

  it("골든 드래프트가 없는 평가 프로필은 오류로 남고 실행은 이어진다", async () => {
    const extra = EVAL_PROFILES.find((p) => p.id === "week4-logged-fullgym")!;
    const first = EVAL_PROFILES[0]!;
    const results = await runEval({ profiles: [extra, first] });
    expect(results.map((r) => r.status)).toEqual(["error", "ok"]);
  });

  it("기준표 블록과 심판 맥락을 읽는다", () => {
    expect(loadRubric()).toContain("안전");
    const context = judgeContext(EVAL_PROFILES.find((p) => p.id === "beginner-bodyweight-lose-fat")!);
    expect(context).toContain("environment=bodyweight_only");
    expect(context).toContain("철봉");
    const logged = judgeContext(EVAL_PROFILES.find((p) => p.id === "week4-logged-fullgym")!);
    expect(logged).toContain("레그프레스(leg_press) reps 12/12/12");
  });
});
