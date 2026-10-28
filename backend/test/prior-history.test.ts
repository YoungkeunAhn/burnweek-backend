import { describe, expect, it } from "vitest";
import { recentPriorLogs, hasHistoryGap } from "../src/generation/prior-history";
import { prescribeLoad } from "../src/generation/loading";
import { byId } from "../src/data/exercises";

const TARGET = "2026-10-26";
const set = (kg = 60, extra = {}) => ({ set_number: 1, set_kind: "working", actual_reps: 15, actual_load_kg: kg, ...extra });
const exercise = (id: string, sets = [set()]) => ({ exercise_id: id, modality: "strength", sets });
const session = (date: string, exercises = [exercise("barbell_squat")]) => ({
  schema_version: "1.0", session_id: date, plan_id: "p", date, day_index: 0, completion: "completed", exercises,
});
const week = (date: string, sessions: Record<string, unknown>) => ({ week_start_date: date, sessions });
const squash = (logs: unknown[]) => (logs as ReturnType<typeof session>[]).flatMap((s) => s.exercises.map((e) => [e.exercise_id, s.date, e.sets[0].actual_load_kg]));

describe("four calendar week prescription snapshot", () => {
  it("selects the latest performed session per exercise, not an older maximum or whole latest week", () => {
    const source = [
      week("2026-10-12", { 0: session("2026-10-12", [exercise("barbell_squat", [set(100)]), exercise("barbell_curl", [set(20)])]) }),
      week("2026-10-19", { 0: session("2026-10-19", [exercise("barbell_squat", [set(70)])]),
        4: { ...session("2026-10-23", [exercise("barbell_squat", [set(50)])]), day_index: 4 } }),
    ];
    const before = structuredClone(source);
    expect(squash(recentPriorLogs(source, TARGET))).toEqual([["barbell_curl", "2026-10-12", 20], ["barbell_squat", "2026-10-23", 50]]);
    expect(source).toEqual(before);
    expect(recentPriorLogs([...source].reverse(), TARGET)).toEqual(recentPriorLogs(source, TARGET));
  });

  it("includes the four-week boundary and excludes older, current, future and misdated records", () => {
    const logs = recentPriorLogs([
      week("2026-09-28", { 0: session("2026-09-28", [exercise("barbell_curl")]) }),
      week("2026-09-21", { 0: session("2026-09-21") }),
      week(TARGET, { 0: session(TARGET) }),
      week("2026-11-02", { 0: session("2026-11-02") }),
      week("2026-10-19", { 0: session(TARGET), 1: session("bad"), 2: session("2026-10-12") }),
    ], TARGET);
    expect(squash(logs)).toEqual([["barbell_curl", "2026-09-28", 60]]);
    expect(recentPriorLogs([], "2026-02-30")).toEqual([]);
  });

  it("empty and warmup-only appearances do not hide a working session, but a failed set does", () => {
    const older = week("2026-10-12", { 0: session("2026-10-12") });
    const partial = week("2026-10-19", { 0: session("2026-10-19", [exercise("barbell_squat", [])]),
      1: { ...session("2026-10-20", [exercise("barbell_squat", [set(20, { set_kind: "warmup" })])]), day_index: 1 } });
    expect(squash(recentPriorLogs([older, partial], TARGET))[0][1]).toBe("2026-10-12");
    const failed = week("2026-10-19", { 0: session("2026-10-19", [exercise("barbell_squat", [set(50, { actual_reps: 0, failed: true })])]) });
    expect(squash(recentPriorLogs([older, failed], TARGET))[0][1]).toBe("2026-10-19");
  });

  it("dates legacy sessions from their owning week; accepts cardio and timed circuits", () => {
    const cardio = { exercise_id: "bicycling_stationary", sets: [{ cardio: { duration_min: 40, style: "LISS" } }] };
    const timed = { exercise_id: "plank", sets: [{ actual_seconds: 30, set_kind: "working" }] };
    const logs = recentPriorLogs([week("2026-10-19", { 2: { day_index: 2, exercises: [cardio, timed] } })], TARGET) as Array<{ date: string; exercises: unknown[] }>;
    expect(logs).toEqual([{ day_index: 2, date: "2026-10-21", exercises: [cardio, timed] }]);
  });

  it("does not restrict the window to four documents or require Monday starts", () => {
    const weeks = Array.from({ length: 8 }, (_, i) => week(`2026-10-${12 + i}`, { 0: session(`2026-10-${12 + i}`, [exercise(`id-${i}`)]) }));
    expect(squash(recentPriorLogs(weeks, TARGET))).toHaveLength(8);
  });
});

describe("history gap progression", () => {
  const load = (date: string, extra = {}, allow = true) => prescribeLoad(byId("barbell_squat")!,
    [session(date, [exercise("barbell_squat", [set(60, extra)])])], "hypertrophy", allow, "beginner", TARGET);

  it("last week's top reps increase, older top reps hold at the performed load with source date", () => {
    expect(load("2026-10-19").progression).toMatchObject({ decision: "increase", to_load_kg: 62.5 });
    expect(load("2026-10-18")).toMatchObject({ targetLoadKg: 60, progression: {
      decision: "hold", reason_code: "history_gap", from_load_kg: 60, to_load_kg: 60, source_date: "2026-10-18",
    } });
    expect(load("2026-10-18", {}, false).progression?.reason_code).toBe("history_gap");
    expect(load("2026-10-19", {}, false).progression?.reason_code).toBe("goal_no_overload");
  });

  it("pain and failure still reduce loads after a gap", () => {
    expect(load("2026-10-12", { pain_flag: true }).progression).toMatchObject({ decision: "decrease", reason_code: "pain_flag" });
    expect(load("2026-10-12", { failed: true }).progression).toMatchObject({ decision: "decrease", reason_code: "missed_reps", to_load_kg: 57.5 });
  });

  it("calendar arithmetic works across the year boundary", () => {
    expect(hasHistoryGap("barbell_squat", [session("2026-12-28")], "2027-01-04")).toBe(false);
    expect(hasHistoryGap("barbell_squat", [session("2026-12-27")], "2027-01-04")).toBe(true);
  });
});
