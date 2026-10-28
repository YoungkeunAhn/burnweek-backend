import { describe, expect, it } from "vitest";
import { parseProgressDraft, readProgressDraft, retireProgressDrafts, reconcileProgressDrafts, swapDayRecords } from "../src/generation/progress-draft";

const input = () => ({
  plan_id: "plan-1", plan_generated_at: "2026-09-23T00:00:00Z", base_revision: 0,
  progress: { barbell_squat: [
    { done: true, kg: "40", reps: "8", rest: 90 },
    { done: false, kg: "50", reps: "", skip: true },
  ] },
});

describe("진행 초안 계약", () => {
  it("미완성 숫자와 제외 세트를 보존한다", () => {
    expect(parseProgressDraft(input())).toEqual(input());
  });

  it("수정 기준 revision과 입력 크기를 제한한다", () => {
    expect(parseProgressDraft({ ...input(), base_revision: -1 })).toBeNull();
    expect(parseProgressDraft({ ...input(), progress: { a: [{ done: true, kg: "1", reps: "2", extra: "x" }] } })).toBeNull();
    expect(parseProgressDraft({ ...input(), progress: { a: [{ done: true, kg: "1".repeat(70_000), reps: "2" }] } })).toBeNull();
  });

  it("서버 값이 손상되면 조용히 빈 초안으로 읽지 않는다", () => {
    expect(readProgressDraft({ plan_id: "plan-1", plan_generated_at: input().plan_generated_at,
      revision: 1, updated_at: "now", closed: false, progress: input().progress })).not.toBeNull();
    expect(readProgressDraft({ plan_id: "plan-1", revision: 1, updated_at: "now", closed: false, progress: { a: "broken" } })).toBeNull();
    expect(readProgressDraft({ plan_id: "plan-1", revision: 2, updated_at: "now", closed: true })).not.toBeNull();
  });

  it("플랜 교체 때 입력은 지우지 않고 닫으며 늦은 revision 쓰기를 막는다", () => {
    const original = { plan_id: "plan-1", plan_generated_at: input().plan_generated_at,
      revision: 3, updated_at: "old", closed: false, progress: input().progress };
    const retired = retireProgressDrafts({ "2": original, "3": original }, 2);
    expect(retired?.["2"]).toMatchObject({ closed: true, revision: 4, progress: input().progress });
    expect(retired?.["3"]).toBeUndefined();
    expect(original.closed).toBe(false);
  });

  it("한 요일 편집은 그 날만 닫고 다른 요일 초안의 세대만 갱신한다", () => {
    const original = { plan_id: "plan-1", plan_generated_at: input().plan_generated_at,
      revision: 3, updated_at: "old", closed: false, progress: input().progress };
    const result = reconcileProgressDrafts({ "2": original, "3": original }, "new-generation", [2]);
    expect(result?.["2"]).toMatchObject({ closed: true, closed_reason: "plan_replaced", revision: 4,
      progress: input().progress });
    expect(result?.["3"]).toMatchObject({ closed: false, revision: 3,
      plan_generated_at: "new-generation", progress: input().progress });
    expect(original.plan_generated_at).toBe(input().plan_generated_at);
  });

  it("요일 교환은 기록과 열린 초안을 운동과 함께 맞바꾼다 — 빈 자리는 null (D79)", () => {
    const open = { plan_id: "plan-1", plan_generated_at: "old", revision: 3, updated_at: "t", closed: false, progress: input().progress };
    const closed = { ...open, closed: true, closed_reason: "session_completed" as const };
    const out = swapDayRecords({ "0": { session_id: "a", day_index: 0, date: "2026-09-21" } }, { "0": open, "2": closed }, 0, 2, "2026-09-21", "new");
    expect(out.sessions).toEqual({ "2": { session_id: "a", day_index: 2, date: "2026-09-23" }, "0": null });
    expect(out.drafts["2"]).toEqual({ ...open, plan_generated_at: "new" });
    expect(out.drafts["0"]).toEqual(closed); // 닫힌 초안은 손대지 않고 옮긴다
    // 둘 다 없으면 둘 다 null — 지울 것도 없다. 주 경계를 넘는 날짜(일요일)도 UTC 로 센다.
    expect(swapDayRecords(undefined, undefined, 1, 6, "2026-09-21", "g")).toEqual({ sessions: { "6": null, "1": null }, drafts: { "6": null, "1": null } });
    expect(swapDayRecords({ "6": { day_index: 6 } }, {}, 6, 0, "2026-09-28", "g").sessions["0"]).toEqual({ day_index: 0, date: "2026-09-28" });
  });
});
