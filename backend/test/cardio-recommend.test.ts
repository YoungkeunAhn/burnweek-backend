import { describe, expect, it } from "vitest";
import { applyCardioOverrides, cardioDoseKey, chooseModality, planCardio, recommendCardio } from "../src/generation/cardio";
import type { UserProfile } from "../src/generation/types";

// 유산소 추천(실행 그래프 N6 · D101 · 백로그 운동목록 06 §5).

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 3,
    session_len_min: 45,
    environment: "full_gym",
    equipment: ["barbell", "dumbbell", "machine", "cable", "body only"],
    cardio_pref: "maintain_health",
    cardio_modalities: [],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}
const BW = { environment: "bodyweight_only" as const, equipment: [] };

describe("recommendCardio", () => {
  it("T6-1 맨몸·감량·입문 → 서킷 A(달리기가 아니라)", () => {
    const r = recommendCardio(profile({ ...BW, goals: ["lose_fat"] }));
    expect(r).toMatchObject({ reason: "bodyweight_circuit", circuitFormats: ["A"] });
  });

  it("T6-2 맨몸·감량·중급 → A·B · 입문은 B 없음(D102 ② · 소음 미고려)", () => {
    expect(recommendCardio(profile({ ...BW, goals: ["lose_fat"], experience_level: "novice_intermediate" })).circuitFormats).toEqual(["A", "B"]);
    expect(recommendCardio(profile({ ...BW, goals: ["lose_fat"] })).circuitFormats).not.toContain("B");
  });

  it("T6-3 헬스장·근비대 → 자전거·인클라인 걷기·일립티컬, 달리기 없음(간섭)", () => {
    const r = recommendCardio(profile());
    expect(r.modalities).toEqual(["cycling", "incline_walk", "elliptical"]);
    expect(r.modalities).not.toContain("running");
  });

  it("T6-4 헬스장·감량 → 인클라인 걷기·천국의 계단·일립티컬 (자전거 고정이 아니다)", () => {
    expect(recommendCardio(profile({ goals: ["lose_fat"] })).modalities).toEqual(["incline_walk", "stairs", "elliptical"]);
    // 첫 목표가 정한다 — cardio_pref 는 첫 목표가 일반 체력·가동성일 때만(codex N6 R1).
    expect(recommendCardio(profile({ goals: ["general_fitness"], cardio_pref: "fat_loss" })).reason).toBe("fat_loss_low_impact");
    expect(recommendCardio(profile({ cardio_pref: "conditioning" })).reason).toBe("hypertrophy_low_interference");
    expect(recommendCardio(profile({ goals: ["lose_fat"], cardio_pref: "conditioning" })).reason).toBe("fat_loss_low_impact");
  });

  it("관절 불편 → 저충격(맨몸이면 걷기 + 서킷 A) · 체력 목표 → 인터벌 종류", () => {
    const joint = { red_flags: { hard: [], low_risk: ["mild_joint_discomfort" as const] } };
    expect(recommendCardio(profile({ ...joint, goals: ["lose_fat"] })).modalities).not.toContain("stairs");
    expect(recommendCardio(profile({ ...BW, ...joint, goals: ["lose_fat"] })).circuitFormats).toEqual(["A"]);
    expect(recommendCardio(profile({ goals: ["endurance"] })).reason).toBe("conditioning_intervals");
  });
});

describe("배치 — 주 안의 세션이 추천 순서로 돌아간다", () => {
  it("주 3회 LISS = 자전거 → 인클라인 걷기 → 일립티컬", () => {
    const strength = [0, 2, 4].map((dayIndex) => ({ dayIndex, order: 1, role: "primary", repIntent: "hypertrophy", requestedId: "x", exercise: { mechanic: "isolation", primary_muscles: ["chest"] } })) as never;
    const { sessions } = planCardio(profile(), strength);
    expect(sessions.map((s) => s.modality)).toEqual(["cycling", "incline_walk", "elliptical"]);
  });

  it("첫 목표 체력이면 인터벌이 실제로 배치된다 · 감량이면 감량 용량 · 명시 선호·none 은 그대로(codex N6 R2)", () => {
    const strength = [0, 2, 4].map((dayIndex) => ({ dayIndex, order: 1, role: "primary", repIntent: "hypertrophy", requestedId: "x", exercise: { mechanic: "isolation", primary_muscles: ["chest"] } })) as never;
    expect(planCardio(profile({ goals: ["endurance"] }), strength).sessions.some((s) => s.style === "HIIT")).toBe(true);
    expect(cardioDoseKey(profile({ goals: ["lose_fat"] }))).toBe("fat_loss");
    expect(cardioDoseKey(profile({ goals: ["endurance"], cardio_pref: "none" }))).toBe("none");
    expect(cardioDoseKey(profile({ goals: ["build_muscle"], cardio_pref: "conditioning" }))).toBe("conditioning");
    // 관절 불편이면 체력 목표·conditioning 선호여도 인터벌 없음(06 §5 최우선 행 · codex N6 R3).
    const joint = { red_flags: { hard: [], low_risk: ["mild_joint_discomfort" as const] } };
    expect(planCardio(profile({ goals: ["endurance"], ...joint }), strength).sessions.some((s) => s.style === "HIIT")).toBe(false);
    expect(planCardio(profile({ cardio_pref: "conditioning", ...joint }), strength).sessions.some((s) => s.style === "HIIT")).toBe(false);
  });

  it("편집으로 빈 날에 넣는 유산소도 같은 용량 키 — 감량 목표면 35분(codex N6 R3)", () => {
    const added = applyCardioOverrides([], new Map([[1, { exercise_id: "bicycling_stationary" }]]), profile({ goals: ["lose_fat"] }), []);
    expect(added[0]!.durationMin).toBe(35);
  });

  it("가진 종류(cardio_modalities — 옛 프로필)가 있으면 그 안에서 추천 순서 · 맨몸은 무시", () => {
    expect(chooseModality(profile({ cardio_modalities: ["rowing", "elliptical"] }))).toBe("elliptical");
    expect(chooseModality(profile({ ...BW, cardio_modalities: ["cycling"] }))).toBe("running");
  });
});
