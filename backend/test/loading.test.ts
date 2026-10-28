import { describe, expect, it } from "vitest";
import {
  REST_SECONDS,
  bestE1rm,
  allowsLoadIncrease,
  decideProgression,
  estimateE1rm,
  pctOf1rm,
  prescribeLoad,
  priorSetsFor,
  repRangeFor,
  roundToPlate,
} from "../src/generation/loading";
import { incrementForMuscles, loadStepFor, startLoadFor } from "../src/data/constants";
import { byId } from "../src/data/exercises";

const SQUAT = byId("barbell_squat")!;
const CURL = byId("barbell_curl")!;

/** PerformedSession v1 fixture with the given sets for one exercise. */
function logs(
  exerciseId: string,
  sets: Array<{ reps: number; kg: number; failed?: boolean; pain?: boolean; warmup?: boolean }>,
) {
  return [
    {
      schema_version: "1.0",
      session_id: "s1",
      plan_id: "p1",
      date: "2026-08-10",
      day_index: 0,
      completion: "completed",
      exercises: [
        {
          exercise_id: exerciseId,
          modality: "strength",
          sets: sets.map((set, i) => ({
            set_number: i + 1,
            set_kind: set.warmup ? "warmup" : "working",
            actual_reps: set.reps,
            actual_load_kg: set.kg,
            ...(set.failed !== undefined ? { failed: set.failed } : {}),
            ...(set.pain !== undefined ? { pain_flag: set.pain } : {}),
          })),
        },
      ],
    },
  ];
}

describe("e1RM (Epley, research/03)", () => {
  it("matches the formula", () => {
    expect(estimateE1rm(10, 100)).toBeCloseTo(133.33, 2);
    expect(estimateE1rm(1, 100)).toBeCloseTo(103.33, 2);
  });

  it("refuses nonsense instead of returning a number", () => {
    for (const [reps, kg] of [
      [0, 100],
      [10, 0],
      [-5, 100],
      [Number.NaN, 100],
    ] as const) {
      expect(estimateE1rm(reps, kg)).toBeUndefined();
    }
  });

  it("takes the best set, not the last", () => {
    const sets = [
      { reps: 5, loadKg: 100, failed: false, painFlag: false, setKind: "working" as const },
      { reps: 12, loadKg: 90, failed: false, painFlag: false, setKind: "working" as const },
    ];
    expect(bestE1rm(sets)).toBeCloseTo(126, 0);
  });

  it("returns undefined when no set is usable", () => {
    expect(bestE1rm([])).toBeUndefined();
  });
});

describe("%1RM continuum (NSCA anchors)", () => {
  it("hits the documented anchors", () => {
    expect(pctOf1rm(1)).toBe(100);
    expect(pctOf1rm(6)).toBe(85);
    expect(pctOf1rm(8)).toBe(80);
    expect(pctOf1rm(12)).toBe(67);
  });

  it("interpolates between anchors and clamps outside them", () => {
    expect(pctOf1rm(9)).toBeCloseTo(77.5, 1);
    expect(pctOf1rm(20)).toBe(65);
    expect(pctOf1rm(0)).toBe(100);
  });

  // T1-6 (040 그래프): 이 앵커가 없으면 12렙 이상이 전부 67% 라 입문자 렙 범위
  // 10–15 가 무게를 1g 도 안 내린다(§1 ③ 재현값 pctOf1rm(15) === 67).
  it("carries the 15-rep anchor for the beginner range (D55 ①)", () => {
    expect(pctOf1rm(12)).toBe(67);
    expect(pctOf1rm(15)).toBe(65);
    expect(pctOf1rm(13.5)).toBeCloseTo(66, 1);
    expect(pctOf1rm(20)).toBe(65);
  });
});

describe("입문자 프리셋 — 렙 범위·증량·격자 (D55 ① · 040 T1-5/T1-7/T1-8)", () => {
  const BENCH = byId("barbell_bench_press_medium_grip")!;
  const DB_CURL = byId("dumbbell_bicep_curl")!;
  const GOBLET = byId("goblet_squat")!;
  const setsAt = (reps: number, kg: number, count = 3) =>
    Array.from({ length: count }, () => ({ reps, loadKg: kg, failed: false, painFlag: false, setKind: "working" as const }));

  it("widens only the hypertrophy range, and only for beginners (T1-5)", () => {
    expect(repRangeFor("hypertrophy", "beginner")).toEqual({ min: 10, max: 15 });
    expect(repRangeFor("hypertrophy", "novice_intermediate")).toEqual({ min: 8, max: 12 });
    expect(repRangeFor("hypertrophy")).toEqual({ min: 8, max: 12 });
    // strength 까지 올리면 gain_strength 입문자가 15렙 스쿼트를 받는다.
    expect(repRangeFor("strength", "beginner")).toEqual({ min: 3, max: 5 });
    expect(repRangeFor("endurance", "beginner")).toEqual({ min: 12, max: 15 });
  });

  it("pairs the grid with the increment — barbell 1.25/2.5 for beginners, hand weights 2kg on a 1kg grid (T1-7)", () => {
    expect(roundToPlate(21.25, 1.25)).toBe(21.25);
    expect(roundToPlate(21.25)).toBe(22.5); // 기본 격자 = 종전
    expect(roundToPlate(3, 1)).toBe(3);
    expect(roundToPlate(4.6, 1)).toBe(5);
    expect(incrementForMuscles(["chest"], "barbell", "beginner")).toBe(1.25);
    expect(incrementForMuscles(["quadriceps"], "barbell", "beginner")).toBe(2.5);
    expect(incrementForMuscles(["chest"], "dumbbell", "novice_intermediate")).toBe(2);
    expect(incrementForMuscles(["biceps"], "dumbbell", "beginner")).toBe(2);
    expect(incrementForMuscles(["chest"])).toBe(2.5); // 기본 = 종전
    // 머신·케이블 스택은 입문자여도 종전 2.5/5 · 격자 2.5 — D55 ① 은 바벨을 말한다(codex R1 #2).
    expect(incrementForMuscles(["chest"], "machine", "beginner")).toBe(2.5);
    expect(incrementForMuscles(["quadriceps"], "cable", "beginner")).toBe(5);
    expect(loadStepFor(["chest"], "machine", "beginner")).toBe(2.5);
    expect(loadStepFor(["chest"], "barbell", "beginner")).toBe(1.25);
    expect(loadStepFor(["quadriceps"], "barbell", "beginner")).toBe(2.5);
    expect(loadStepFor(["biceps"], "dumbbell", "beginner")).toBe(1);
    expect(loadStepFor(["biceps"], "kettlebells", "novice_intermediate")).toBe(1);
    expect(loadStepFor(["chest"], "barbell", "novice_intermediate")).toBe(2.5);
  });

  it("carries the beginner increment end-to-end through the decision (T1-8)", () => {
    const bench = decideProgression(BENCH, setsAt(15, 20), 15, true, "beginner")!;
    expect(bench).toMatchObject({ decision: "increase", to_load_kg: 21.25 });
    const curl = decideProgression(DB_CURL, setsAt(15, 3), 15, true, "beginner")!;
    expect(curl).toMatchObject({ decision: "increase", to_load_kg: 5 });
    const goblet = decideProgression(GOBLET, setsAt(15, 8), 15, true)!;
    expect(goblet).toMatchObject({ decision: "increase", to_load_kg: 10 });
    // 격자 밖 무게(사용자가 적은 7.5kg)에서도 정확히 +2 — 반올림하면 10(+2.5)이 된다(codex R1 #3).
    const offGrid = decideProgression(DB_CURL, setsAt(15, 7.5), 15, true, "beginner")!;
    expect(offGrid).toMatchObject({ decision: "increase", to_load_kg: 9.5 });
    const offGridBar = decideProgression(BENCH, setsAt(15, 21), 15, true, "beginner")!;
    expect(offGridBar).toMatchObject({ decision: "increase", to_load_kg: 22.25 });
    // 초중급 바벨은 종전 그대로.
    const novice = decideProgression(BENCH, setsAt(12, 20), 12, true, "novice_intermediate")!;
    expect(novice).toMatchObject({ decision: "increase", to_load_kg: 22.5 });
    // prescribeLoad 도 같은 격자를 타야 한다 — 기본 격자로 부르면 여기서 22.5 가 된다.
    const prescribed = prescribeLoad(BENCH, logs("barbell_bench_press_medium_grip", [{ reps: 15, kg: 20 }, { reps: 15, kg: 20 }]), "hypertrophy", true, "beginner");
    expect(prescribed.targetLoadKg).toBe(21.25);
    expect(prescribed.repsHigh).toBe(12); // 입문자 복합 8–12(D104 ②)
  });

  it("never prescribes below the equipment floor — the empty bar is the floor for everyone (T2-3)", () => {
    // 입문자 20kg 실패·통증 → 내릴 무게가 없다 → substitute
    expect(decideProgression(BENCH, [{ ...setsAt(10, 20, 1)[0], failed: true }], 15, true, "beginner")!.decision).toBe("substitute");
    expect(decideProgression(BENCH, [{ ...setsAt(10, 20, 1)[0], painFlag: true }], 15, true, "beginner")!.decision).toBe("substitute");
    // 하한 위는 종전대로 한 단계.
    expect(decideProgression(BENCH, [{ ...setsAt(10, 40, 1)[0], failed: true }], 15, true, "beginner")!).toMatchObject({ decision: "decrease", to_load_kg: 38.75 });
    // 초중급도 바는 20 이 바닥이다 — 22.5 실패 → 20(하한 위) · 20 실패 → substitute(종전엔 17.5 를 처방했다)
    expect(decideProgression(BENCH, [{ ...setsAt(8, 22.5, 1)[0], failed: true }], 12)!).toMatchObject({ decision: "decrease", to_load_kg: 20 });
    expect(decideProgression(BENCH, [{ ...setsAt(8, 20, 1)[0], failed: true }], 12)!.decision).toBe("substitute");
    // 덤벨은 격자 한 칸(1kg)이 바닥.
    expect(decideProgression(DB_CURL, [{ ...setsAt(10, 3, 1)[0], failed: true }], 15, true, "beginner")!).toMatchObject({ decision: "decrease", to_load_kg: 1 });
    expect(decideProgression(DB_CURL, [{ ...setsAt(10, 1, 1)[0], failed: true }], 15, true, "beginner")!.decision).toBe("substitute");
  });

  it("seeds week-1 loads for beginners from the equipment table, and never over history (T2-1)", () => {
    const LEG_PRESS = byId("leg_press")!;
    const DB_PRESS = byId("dumbbell_shoulder_press")!;
    expect(startLoadFor(BENCH, "beginner")).toBe(20);
    // 덤벨은 낮은 쪽 하나 — 성별은 서버에 오지 않는다(2026-09-15).
    expect(startLoadFor(DB_PRESS, "beginner")).toBe(3);
    expect(startLoadFor(DB_CURL, "beginner")).toBe(1);
    expect(startLoadFor({ equipment: "dumbbell", mechanic: null }, "beginner")).toBe(1); // mechanic null → 고립값(Q3)
    expect(startLoadFor(GOBLET, "beginner")).toBe(8);
    expect(startLoadFor(LEG_PRESS, "beginner")).toBeNull(); // 머신 — 눈금이 다르다
    expect(startLoadFor({ equipment: "other", mechanic: "compound" }, "beginner")).toBeNull();
    expect(startLoadFor({ equipment: "body only", mechanic: "compound" }, "beginner")).toBeNull();
    expect(startLoadFor(BENCH, "novice_intermediate")).toBeNull();
    expect(startLoadFor(BENCH)).toBeNull();
    // prescribeLoad: 이력 없음 + 입문자 → 시작값 · 이력 있으면 기록이 이긴다 · 초중급은 null
    const fresh = prescribeLoad(BENCH, [], "hypertrophy", true, "beginner");
    expect(fresh.targetLoadKg).toBe(20);
    expect(fresh.progression).toBeNull();
    expect(fresh.targetLoadPct1rm).toBeNull();
    const logged = prescribeLoad(BENCH, logs("barbell_bench_press_medium_grip", [{ reps: 10, kg: 40 }]), "hypertrophy", true, "beginner");
    expect(logged.targetLoadKg).not.toBe(20);
    expect(logged.targetLoadKg).toBe(40);
    expect(prescribeLoad(BENCH, [], "hypertrophy", true, "novice_intermediate").targetLoadKg).toBeNull();
    expect(prescribeLoad(BENCH, [], "hypertrophy", true).targetLoadKg).toBeNull();
  });

  it("steps down on the beginner grid too (T2-3 선행 — 하한은 N2)", () => {
    const failed = decideProgression(BENCH, [{ ...setsAt(10, 40, 1)[0], failed: true }], 15, true, "beginner")!;
    expect(failed).toMatchObject({ decision: "decrease", to_load_kg: 38.75 });
    const dbFailed = decideProgression(DB_CURL, [{ ...setsAt(10, 3, 1)[0], failed: true }], 15, true, "beginner")!;
    expect(dbFailed).toMatchObject({ decision: "decrease", to_load_kg: 1 });
    const offGridFailed = decideProgression(DB_CURL, [{ ...setsAt(10, 7.5, 1)[0], failed: true }], 15, true, "beginner")!;
    expect(offGridFailed).toMatchObject({ decision: "decrease", to_load_kg: 5.5 });
    // 통증 감량(−10%)은 종전대로 격자로 내림.
    const pain = decideProgression(DB_CURL, [{ ...setsAt(10, 7.5, 1)[0], painFlag: true }], 15, true, "beginner")!;
    expect(pain).toMatchObject({ decision: "decrease", to_load_kg: 6 });
  });
});

describe("plate rounding", () => {
  it("lands on 2.5 kg steps and never below one step", () => {
    expect(roundToPlate(61.2)).toBe(60);
    expect(roundToPlate(63.8)).toBe(65);
    expect(roundToPlate(0.4)).toBe(2.5);
  });
});

describe("prior-log reading", () => {
  it("picks out only the requested exercise's strength sets", () => {
    const priorLogs = [
      {
        exercises: [
          {
            exercise_id: "barbell_squat",
            modality: "strength",
            sets: [{ set_number: 1, set_kind: "working", actual_reps: 8, actual_load_kg: 60 }],
          },
          {
            exercise_id: "barbell_curl",
            modality: "strength",
            sets: [{ set_number: 1, set_kind: "working", actual_reps: 10, actual_load_kg: 20 }],
          },
        ],
      },
    ];
    expect(priorSetsFor("barbell_squat", priorLogs)).toEqual([
      { reps: 8, loadKg: 60, failed: false, painFlag: false, setKind: "working" },
    ]);
  });

  it("skips cardio sets, which carry no load", () => {
    const priorLogs = [
      {
        exercises: [
          {
            exercise_id: "bicycling_stationary",
            modality: "cardio",
            sets: [{ set_number: 1, cardio: { modality: "cycling", duration_min: 20 } }],
          },
        ],
      },
    ];
    expect(priorSetsFor("bicycling_stationary", priorLogs)).toEqual([]);
  });

  it("survives malformed logs", () => {
    expect(priorSetsFor("barbell_squat", [null, 7, "nope", { exercises: [{}] }])).toEqual([]);
  });
});

describe("double progression (S-GEN-9/10/11)", () => {
  const setsAt = (reps: number, kg: number, count = 3) =>
    Array.from({ length: count }, () => ({
      reps,
      loadKg: kg,
      failed: false,
      painFlag: false,
      setKind: "working" as const,
    }));
  const warmupAt = (reps: number, kg: number) => ({
    reps,
    loadKg: kg,
    failed: false,
    painFlag: false,
    setKind: "warmup" as const,
  });

  it("has no decision on week 1 — the contract says 2주차+", () => {
    expect(decideProgression(SQUAT, [], 12)).toBeNull();
  });

  it("increases when every working set hit the top of the range (S-GEN-10)", () => {
    const decision = decideProgression(SQUAT, setsAt(12, 60), 12)!;
    expect(decision.decision).toBe("increase");
    expect(decision.reason_code).toBe("hit_top_reps");
    expect(decision.from_load_kg).toBe(60);
    expect(decision.to_load_kg).toBe(65); // lower body: +5 kg
  });

  // 목표 게이팅(ACSM 2026): 증량은 근비대·근력 목표에서만. 감량·교체는 안전이라
  // 목표와 무관하게 항상 돈다 — 이 비대칭이 깨지면 통증 신호가 무시된다.
  describe("목표 게이팅", () => {
    it("증량형 목표에서만 무게를 올린다", () => {
      expect(allowsLoadIncrease(["build_muscle"])).toBe(true);
      expect(allowsLoadIncrease(["gain_strength"])).toBe(true);
      expect(allowsLoadIncrease(["general_fitness", "mobility"])).toBe(false);
      // 하나라도 증량형이면 올린다.
      expect(allowsLoadIncrease(["lose_fat", "build_muscle"])).toBe(true);
      expect(allowsLoadIncrease([])).toBe(false);
    });

    it("증량형이 아니면 렙 상단을 채워도 무게를 유지한다", () => {
      const decision = decideProgression(SQUAT, setsAt(12, 60), 12, false)!;
      expect(decision.decision).toBe("hold");
      expect(decision.reason_code).toBe("goal_no_overload");
      expect(decision.to_load_kg).toBe(60);
    });

    it("증량형이 아니어도 통증·실패로 인한 감량은 그대로 적용한다", () => {
      const pain = decideProgression(SQUAT, [{ ...setsAt(12, 60, 1)[0], painFlag: true }], 12, false)!;
      expect(pain.decision).toBe("decrease");
      expect(pain.to_load_kg!).toBeLessThan(60);

      const failed = decideProgression(SQUAT, [{ ...setsAt(12, 60, 1)[0], failed: true }], 12, false)!;
      expect(failed.decision).toBe("decrease");
      expect(failed.to_load_kg).toBe(55);
    });

    it("prescribeLoad 도 같은 게이트를 통과한다", () => {
      const topOfRange = Array.from({ length: 3 }, () => ({ reps: 12, kg: 60 }));
      const held = prescribeLoad(SQUAT, logs("barbell_squat", topOfRange), "hypertrophy", false);
      expect(held.progression!.decision).toBe("hold");
      expect(held.targetLoadKg).toBe(60);
      const raised = prescribeLoad(SQUAT, logs("barbell_squat", topOfRange), "hypertrophy", true);
      expect(raised.progression!.decision).toBe("increase");
      expect(raised.targetLoadKg).toBe(65);
    });
  });

  it("uses the upper-body increment for upper-body lifts", () => {
    const decision = decideProgression(CURL, setsAt(12, 20), 12)!;
    expect(decision.to_load_kg).toBe(22.5); // +2.5 kg
  });

  it("holds when reps are still climbing inside the range", () => {
    const decision = decideProgression(SQUAT, setsAt(9, 60), 12)!;
    expect(decision.decision).toBe("hold");
    expect(decision.reason_code).toBe("reps_in_progress");
    expect(decision.to_load_kg).toBe(60);
  });

  it("ignores warmup sets when judging the top of the range (S-GEN-10)", () => {
    // Regression: a light warmup used to drag `every(reps >= high)` to false and
    // block every increase.
    const sets = [warmupAt(5, 30), ...setsAt(12, 60)];
    const decision = decideProgression(SQUAT, sets, 12)!;
    expect(decision.decision).toBe("increase");
    expect(decision.from_load_kg).toBe(60);
  });

  it("returns no decision when only warmups were logged", () => {
    expect(decideProgression(SQUAT, [warmupAt(5, 30)], 12)).toBeNull();
  });

  it("substitutes instead of claiming a decrease it cannot deliver", () => {
    const decision = decideProgression(CURL, [{ ...setsAt(8, 2.5, 1)[0], painFlag: true }], 12)!;
    expect(decision.decision).toBe("substitute");
    expect(decision.to_load_kg).toBeNull();
  });

  it("never rounds a decrease upward", () => {
    // 26kg 바벨 컬 통증: −10% = 23.4 → 22.5. (6kg 바벨은 존재하지 않는다 — 빈 바 20kg 하한, D55 ②)
    const decision = decideProgression(CURL, [{ ...setsAt(8, 26, 1)[0], painFlag: true }], 12)!;
    expect(decision.decision).toBe("decrease");
    expect(decision.to_load_kg!).toBeLessThan(26);
    expect(decision.to_load_kg).toBe(22.5);
  });

  it("steps a missed-rep decrease down by one increment, not a magic percentage", () => {
    const decision = decideProgression(SQUAT, [{ ...setsAt(8, 60, 1)[0], failed: true }], 12)!;
    expect(decision.to_load_kg).toBe(55);
  });

  it("classifies the increment by muscle, not by the volume cap group", () => {
    // The deadlift's primary muscle is `lower back`, which rolls up to the
    // `back` cap group — but it is still a lower-body lift (+5 kg).
    const deadlift = byId("barbell_deadlift")!;
    const decision = decideProgression(deadlift, setsAt(12, 100), 12)!;
    expect(decision.to_load_kg).toBe(105);
  });

  it("decreases on a pain flag, ahead of every other rule (S-GEN-11)", () => {
    // Pain plus a full set of top reps: safety still wins.
    const sets = [...setsAt(12, 60), { ...setsAt(12, 60, 1)[0], painFlag: true }];
    const decision = decideProgression(SQUAT, sets, 12)!;
    expect(decision.decision).toBe("decrease");
    expect(decision.reason_code).toBe("pain_flag");
    expect(decision.to_load_kg).toBeLessThan(60);
  });

  it("decreases on a failed set (S-GEN-11)", () => {
    const sets = [...setsAt(12, 60, 2), { ...setsAt(6, 60, 1)[0], failed: true }];
    const decision = decideProgression(SQUAT, sets, 12)!;
    expect(decision.decision).toBe("decrease");
    expect(decision.reason_code).toBe("missed_reps");
  });
});

describe("load prescription", () => {
  it("prescribes no weight on week 1 rather than inventing one", () => {
    const prescription = prescribeLoad(SQUAT, []);
    expect(prescription.targetLoadKg).toBeNull();
    expect(prescription.targetLoadPct1rm).toBeNull();
    expect(prescription.progression).toBeNull();
    // Reps and rest are still prescribed — only the load is unknown.
    // 초중급 복합 5–10(D104 ②).
    expect(prescription.repsLow).toBe(5);
    expect(prescription.repsHigh).toBe(10);
    expect(prescription.restSeconds).toBe(REST_SECONDS.compound);
  });

  it("derives the target from the logged e1RM on week 2+", () => {
    const prescription = prescribeLoad(SQUAT, logs("barbell_squat", [{ reps: 8, kg: 60 }]));
    // hold decision → stays at the load actually used
    expect(prescription.progression?.decision).toBe("hold");
    expect(prescription.targetLoadKg).toBe(60);
    expect(prescription.targetLoadPct1rm).toBeGreaterThan(0);
  });

  it("follows the progression decision when it moves the load", () => {
    const prescription = prescribeLoad(
      SQUAT,
      logs("barbell_squat", [
        { reps: 12, kg: 60 },
        { reps: 12, kg: 60 },
      ]),
    );
    expect(prescription.progression?.decision).toBe("increase");
    expect(prescription.targetLoadKg).toBe(65);
  });

  it("gives isolation work shorter rest than compounds", () => {
    expect(prescribeLoad(CURL, []).restSeconds).toBe(REST_SECONDS.isolation);
  });

  it("keeps rep ranges tied to the intent", () => {
    expect(repRangeFor("strength")).toEqual({ min: 3, max: 5 });
    expect(repRangeFor("hypertrophy")).toEqual({ min: 8, max: 12 });
    expect(repRangeFor("endurance")).toEqual({ min: 12, max: 15 });
  });
});
