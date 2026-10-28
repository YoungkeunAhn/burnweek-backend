/**
 * 성장 비교 — 계약 §2.6.2 · D90 · [실행 그래프](../../docs/guides/miniapp-usage-push-dashboard-execution-graph.md) T1.
 * 핸들러(400·exercise_id 우선)는 `generation-api-contract.test.ts` 가 본다.
 */
import { describe, expect, it } from "vitest";
import { growthTrend, isCalendarDate, previousWeekOf } from "../src/generation/history";
import type { SavedWeek } from "../src/generation/edit";

const set = (kg: number, reps: number, kind = "working") => ({ set_number: 1, set_kind: kind, actual_reps: reps, actual_load_kg: kg });
const week = (start: string, items: Array<[string, Array<Record<string, unknown>>]>): SavedWeek => ({
  week_start_date: start,
  sessions: { 0: { exercises: items.map(([exercise_id, sets]) => ({ exercise_id, modality: "strength", sets })) } },
});

describe("growthTrend (T1)", () => {
  it("previousWeekOf 는 7일 전이다 — 월·연 경계", () => {
    expect(previousWeekOf("2026-10-05")).toBe("2026-09-28");
    expect(previousWeekOf("2026-01-05")).toBe("2025-12-29");
  });

  it("isCalendarDate 는 없는 날짜를 거른다", () => {
    expect(isCalendarDate("2026-10-05")).toBe(true);
    for (const bad of ["2026-13-01", "2026-02-30", "zzz", undefined, 20261005]) expect(isCalendarDate(bad)).toBe(false);
  });

  it("두 주 모두에 한 종목만 싣고 statOf 값을 그대로 준다", () => {
    const prev = week("2026-09-28", [["squat", [set(80, 5)]], ["bench", [set(60, 8)]]]);
    const cur = week("2026-10-05", [["squat", [set(82.5, 5), set(70, 5, "warmup")]], ["row", [set(26, 8)]]]);
    expect(growthTrend(cur, prev, "2026-10-05")).toEqual({
      week_start_date: "2026-10-05",
      previous_week: "2026-09-28",
      exercises: [{
        exercise_id: "squat",
        previous: { top_load_kg: 80, top_reps: 5, one_rm_kg: 93.3, volume_kg: 400 },
        current: { top_load_kg: 82.5, top_reps: 5, one_rm_kg: 96.3, volume_kg: 412.5 },
      }],
    });
  });

  it("지난주 문서가 없으면 비교할 것이 없다 — 더 옛 주로 넘어가지 않는다", () => {
    const cur = week("2026-10-05", [["squat", [set(82.5, 5)]]]);
    expect(growthTrend(cur, null, "2026-10-05").exercises).toEqual([]);
    expect(growthTrend(null, cur, "2026-10-12").exercises).toEqual([]);
  });

  it("0회 세트·웜업만 있는 종목은 그 주에 없는 것이다", () => {
    const prev = week("2026-09-28", [["squat", [set(80, 0)]]]);
    const cur = week("2026-10-05", [["squat", [set(82.5, 5)]]]);
    expect(growthTrend(cur, prev, "2026-10-05").exercises).toEqual([]);
  });
});
