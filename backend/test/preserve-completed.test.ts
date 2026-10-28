import { describe, expect, it } from "vitest";
import { preserveCompletedDays } from "../src/generation/session";

// 044 N1 · D60 ① — 재생성 저장 직전 병합. 순수함수라 문서 두 개로 증명한다.
const day = (day_index: number, tag: string) => ({ day_index, tag });
const week = (...days: Array<{ day_index: number; tag: string }>) => ({ week: days });
const tags = (x: unknown) => (x as { week: Array<{ tag: string }> }).week.map((d) => d.tag);

describe("preserveCompletedDays — 완료한 요일은 새 플랜이 덮지 않는다 (044 N1 · D60 ①)", () => {
  const saved = {
    plan: week(day(0, "A"), day(3, "C")),
    draft: week(day(0, "a"), day(3, "c")),
    sessions: { 0: { session_id: "s0" } },
  };
  const next = {
    plan: week(day(0, "B0"), day(2, "B2"), day(4, "B4")),
    draft: week(day(0, "b0"), day(2, "b2"), day(4, "b4")),
  };

  it("T1-1 세션 있는 요일만 옛 것으로 — plan·draft 둘 다, 요일 오름차순, 입력 불변", () => {
    const out = preserveCompletedDays(saved, next);
    expect(out.plan).toEqual(week(day(0, "A"), day(2, "B2"), day(4, "B4")));
    expect(out.draft).toEqual(week(day(0, "a"), day(2, "b2"), day(4, "b4")));
    expect(tags(next.plan)).toEqual(["B0", "B2", "B4"]); // 입력은 그대로다
    expect(tags(saved.plan)).toEqual(["A", "C"]);
  });

  it("T1-4 세션 0 · 첫 생성(saved 없음) — 새 것 그대로, 예외 없음", () => {
    expect(preserveCompletedDays(undefined, next)).toBe(next);
    expect(preserveCompletedDays(null, next)).toBe(next);
    expect(preserveCompletedDays({ ...saved, sessions: {} }, next)).toBe(next);
    expect(preserveCompletedDays({ ...saved, sessions: undefined }, next)).toBe(next);
  });

  it("T1-5 새 플랜이 완료 요일에도 훈련일을 뒀으면 옛 것이 이긴다 — 새 day 0 은 버려진다(Q2 ㉠ · 회수는 세지 않는다)", () => {
    const out = preserveCompletedDays(saved, next);
    expect(tags(out.plan)).toEqual(["A", "B2", "B4"]);
    expect(tags(out.plan)).not.toContain("B0");
  });

  it("T1-6 새 플랜에 없는 요일(옮겨서 완료한 날)도 되살린다 — 회수가 days_per_week 를 넘어도 된다", () => {
    const moved = { plan: week(day(1, "A1")), draft: week(day(1, "a1")), sessions: { 1: { session_id: "s1" } } };
    const out = preserveCompletedDays(moved, next);
    expect(out.plan).toEqual(week(day(0, "B0"), day(1, "A1"), day(2, "B2"), day(4, "B4")));
    expect(out.draft).toEqual(week(day(0, "b0"), day(1, "a1"), day(2, "b2"), day(4, "b4")));
  });

  it("T1-7 옛 문서에 draft 가 없으면(016 이전) 보존하지 않는다 — 반쪽 보존은 편집이 되돌린다(codex R1) · 예외 없음", () => {
    expect(preserveCompletedDays({ plan: saved.plan, sessions: saved.sessions }, next)).toBe(next);
    expect(preserveCompletedDays({ draft: saved.draft, sessions: saved.sessions }, next)).toBe(next);
  });

  it("세션 키가 요일(0–6)이 아니거나 값이 객체가 아니면 완료로 세지 않는다", () => {
    const out = preserveCompletedDays({ ...saved, sessions: { 0: null, 7: {}, x: {} } }, next);
    expect(out).toBe(next);
  });
});
