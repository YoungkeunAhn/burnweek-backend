/** 이번 주 생성은 오늘부터(D80 · 백로그 080) — `weekProfile` 순수함수. */
import { describe, expect, it } from "vitest";
import { weekProfile } from "../src/generation/expand";
import type { UserProfile } from "../src/generation/types";

const P: UserProfile = {
  goals: ["build_muscle"], experience_level: "beginner", days_per_week: 2, session_len_min: 45,
  environment: "full_gym", equipment: ["barbell"], cardio_pref: "maintain_health", cardio_modalities: [],
  injuries: [], red_flags: { hard: [], low_risk: [] }, available_days: [0, 1, 2, 3, 4, 5, 6],
};
const WEEK = "2026-09-21"; // 월
/** KST 그 날 10:00 의 epoch ms. `day` 0 = 월. */
const kst = (day: number, hour = 10) => Date.parse(`2026-09-${21 + day}T${String(hour).padStart(2, "0")}:00:00+09:00`);

describe("weekProfile — 요일 후보는 가능요일 ∩ 오늘~일 (D80)", () => {
  it("T2-1 목요일 · 7일 · 주 2회 → 목~일 · 2회", () => {
    expect(weekProfile(P, WEEK, kst(3))).toMatchObject({ available_days: [3, 4, 5, 6], days_per_week: 2 });
  });

  it("T2-2 토요일 · 주 3회 → 토·일 · 2회(남은 날만큼)", () => {
    expect(weekProfile({ ...P, days_per_week: 3 }, WEEK, kst(5))).toMatchObject({ available_days: [5, 6], days_per_week: 2 });
  });

  it("T2-3 일요일 → 1회 · 분할 선택 없음", () => {
    const out = weekProfile({ ...P, split_pref: "upper_lower" }, WEEK, kst(6));
    expect(out).toMatchObject({ available_days: [6], days_per_week: 1 });
    expect(out.split_pref).toBeUndefined();
    expect(weekProfile({ ...P, days_per_week: 3, split_pref: "upper_lower" }, WEEK, kst(5)).split_pref).toBe("upper_lower");
  });

  it("T2-4 오늘 이후 가능요일이 없으면 오늘~일 전부", () => {
    expect(weekProfile({ ...P, available_days: [0, 2] }, WEEK, kst(3))).toMatchObject({ available_days: [3, 4, 5, 6], days_per_week: 2 });
    expect(weekProfile({ ...P, available_days: [0, 4] }, WEEK, kst(3))).toMatchObject({ available_days: [4], days_per_week: 1 });
  });

  it("T2-5 월요일이거나 다른 주면 그대로", () => {
    expect(weekProfile(P, WEEK, kst(0))).toBe(P);
    expect(weekProfile(P, "2026-09-28", kst(3))).toBe(P);
    expect(weekProfile(P, "2026-09-14", kst(3))).toBe(P);
    const legacy = { ...P, available_days: undefined };
    expect(weekProfile(legacy, WEEK, kst(4))).toMatchObject({ available_days: [4, 5, 6], days_per_week: 2 });
  });

  it("T2-6 KST 로 센다 — UTC 수 15:00 = KST 목 00:00", () => {
    expect(weekProfile(P, WEEK, Date.parse("2026-09-23T15:00:00Z")).available_days).toEqual([3, 4, 5, 6]);
    expect(weekProfile(P, WEEK, Date.parse("2026-09-23T14:59:00Z")).available_days).toEqual([2, 3, 4, 5, 6]);
  });
});
