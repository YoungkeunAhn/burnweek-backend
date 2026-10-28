/**
 * 운동일 아침 푸시 판정 — 계약 §2.8 · D90 · [실행 그래프](../../docs/guides/miniapp-usage-push-dashboard-execution-graph.md) T10.
 * 동의 저장·탈퇴 삭제·예약 발송(T11–T13)은 `generation-api-contract.test.ts` 가 본다.
 */
import { describe, expect, it } from "vitest";
import { mondayOf, seoulToday, workoutDayFocus } from "../src/generation/workout-day";

const ex = [{ exercise_id: "barbell_squat" }];
const doc = (week: unknown[]) => ({ week_start_date: "2026-10-05", plan: { week } });

describe("workoutDayFocus (T10)", () => {
  it("서울 날짜 — UTC 23시는 다음 날 아침 8시다", () => {
    expect(seoulToday(new Date("2026-10-05T23:00:00Z"))).toBe("2026-10-06");
    expect(seoulToday(new Date("2026-10-06T14:59:00Z"))).toBe("2026-10-06");
  });

  it("주의 월요일 — 일요일은 앞 주", () => {
    expect(mondayOf("2026-10-06")).toBe("2026-10-05");
    expect(mondayOf("2026-10-11")).toBe("2026-10-05");
    expect(mondayOf("2026-10-05")).toBe("2026-10-05");
  });

  it("오늘이 운동일이면 그날 focus", () => {
    expect(workoutDayFocus(doc([{ day_index: 1, session_type: "strength", focus: "하체", exercises: ex }]), "2026-10-06")).toBe("하체");
  });

  it("휴식 · 빈 종목 · 그날 없음(희소 배열) · 주 밖 · 문서 없음은 보내지 않는다", () => {
    expect(workoutDayFocus(doc([{ day_index: 1, session_type: "rest", focus: "휴식", exercises: [] }]), "2026-10-06")).toBeNull();
    expect(workoutDayFocus(doc([{ day_index: 1, session_type: "strength", focus: "하체", exercises: [] }]), "2026-10-06")).toBeNull();
    expect(workoutDayFocus(doc([{ day_index: 0, session_type: "strength", focus: "가슴", exercises: ex }]), "2026-10-06")).toBeNull();
    expect(workoutDayFocus(doc([{ day_index: 1, session_type: "strength", focus: "하체", exercises: ex }]), "2026-10-13")).toBeNull();
    expect(workoutDayFocus(null, "2026-10-06")).toBeNull();
  });
});
