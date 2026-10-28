/**
 * 요일 제목 라벨 (백로그 011). LLM 이 쓰던 시절 제목이 화면에서 두 줄로 넘쳤다 —
 * 여기서 고정하는 건 "짧다"가 아니라 **어떤 어휘만 나오는가**다.
 */
import { describe, expect, it } from "vitest";
import { expandDraftToWeeklyPlan, focusLabel } from "../src/generation/expand";
import { MEDICAL_DISCLAIMER } from "../src/generation/safety";
import { GOLDEN_PROFILES } from "./fixtures/golden-profiles";
import drafts from "./fixtures/golden-drafts.json";

/** 세트 n개짜리 근력 운동 하나. */
const lift = (muscles: string[], n = 3) => ({
  modality: "barbell",
  primary_muscles: muscles,
  sets: Array.from({ length: n }, () => ({ set_kind: "working" })),
});
const cardio = () => ({ modality: "cardio", cardio_detail: { duration_min: 30 } });

describe("focusLabel", () => {
  const CASES: Array<[string, Record<string, unknown>[], string]> = [
    ["가슴+삼두 푸시", [lift(["chest"], 4), lift(["triceps"], 2)], "가슴 + 삼두"],
    ["등+이두 풀", [lift(["lats"], 4), lift(["middle back"], 3), lift(["biceps"], 2)], "등 + 이두"],
    ["하체는 한 그룹으로 접힌다", [lift(["quadriceps"], 4), lift(["glutes"], 3), lift(["calves"], 2)], "하체"],
    ["팔은 주 부위와 섞이면 밀려난다", [lift(["chest"], 4), lift(["shoulders"], 3), lift(["triceps"], 2)], "가슴 + 어깨"],
    ["주 부위 3개 → 상체", [lift(["chest"], 4), lift(["lats"], 3), lift(["shoulders"], 3)], "상체"],
    ["하체가 섞이면 → 전신", [lift(["chest"], 4), lift(["shoulders"], 3), lift(["quadriceps"], 3)], "전신"],
    ["복근 전담일", [lift(["abdominals"], 4)], "복근"],
    ["팔 전담일", [lift(["biceps"], 4), lift(["triceps"], 3)], "이두 + 삼두"],
    ["유산소만", [cardio()], "유산소"],
    ["빈 날", [], "유산소"],
  ];

  for (const [name, exercises, expected] of CASES) {
    it(name, () => expect(focusLabel(exercises)).toBe(expected));
  }

  it("세트 수가 많은 그룹이 앞에 온다", () => {
    expect(focusLabel([lift(["lats"], 5), lift(["chest"], 2)])).toBe("등 + 가슴");
  });

  it("동률은 고정 순서로 깬다 — 같은 입력이면 같은 라벨", () => {
    expect(focusLabel([lift(["lats"], 3), lift(["chest"], 3)])).toBe("가슴 + 등");
    expect(focusLabel([lift(["chest"], 3), lift(["lats"], 3)])).toBe("가슴 + 등");
  });
});

describe("확장 엔진 통합", () => {
  const ALLOWED = new Set(["가슴", "등", "어깨", "하체", "이두", "삼두", "복근", "전완", "목", "상체", "전신", "유산소"]);

  it("골든 드래프트의 모든 요일 제목이 정해진 어휘로만 이루어진다", () => {
    const item = GOLDEN_PROFILES[0]!;
    const draft = (drafts as { cases: Record<string, { draft: unknown }> }).cases[item.id]!.draft;
    const { plan } = expandDraftToWeeklyPlan({
      draft,
      profile: item.profile,
      userId: "u1",
      weekStartDate: "2026-08-17",
      weekNumber: 1,
      priorLogs: [],
      disclaimer: MEDICAL_DISCLAIMER,
    }) as { plan: { week: Array<{ focus: string }> } };

    expect(plan.week.length).toBeGreaterThan(0);
    for (const day of plan.week) {
      for (const token of day.focus.split(" + ")) expect(ALLOWED, day.focus).toContain(token);
    }
  });
});
