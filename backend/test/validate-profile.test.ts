/**
 * 프로필 신뢰 경계. 온보딩이 붙기 전에는 클라이언트가 상수를 보내서 아무도
 * 이 값을 검사하지 않았다 — 사용자 입력이 들어오는 지금은 여기가 마지막 방어선이다.
 */
import { describe, expect, it } from "vitest";
import { validateProfile } from "../src/generation/validate-profile";

/** 계약이 요구하는 필수 필드만 가진 최소 프로필. */
const minimal = {
  goals: ["build_muscle"],
  experience_level: "beginner",
  days_per_week: 3,
  environment: "full_gym",
  equipment: ["barbell"],
};

function ok(patch: Record<string, unknown> = {}) {
  const r = validateProfile({ ...minimal, ...patch });
  if ("error" in r) throw new Error(`유효해야 하는데 거부됨: ${r.error}`);
  return r.profile;
}

function rejected(patch: Record<string, unknown>) {
  const r = validateProfile({ ...minimal, ...patch });
  expect(r).toHaveProperty("error");
}

describe("validateProfile", () => {
  it("필수 필드만 있으면 선택 필드를 계약 기본값으로 채운다", () => {
    const p = ok();
    // 기본값은 questionnaire.md "기본값" 절이 정본이다.
    expect(p.session_len_min).toBe(45);
    expect(p.cardio_pref).toBe("maintain_health");
    expect(p.cardio_modalities).toEqual([]);
    expect(p.injuries).toEqual([]);
    expect(p.red_flags).toEqual({ hard: [], low_risk: [] });
  });

  it("enum 밖의 값을 거부한다", () => {
    rejected({ goals: ["get_shredded"] });
    rejected({ experience_level: "advanced" }); // 클라이언트가 하향 매핑할 책임이다
    rejected({ environment: "home_minimal" }); // 미니앱이 실제로 보내던 값
    rejected({ cardio_pref: "sometimes" });
    rejected({ session_len_min: 55 });
  });

  it("goals 는 1–3개다", () => {
    rejected({ goals: [] });
    rejected({ goals: ["build_muscle", "lose_fat", "mobility", "endurance"] });
    expect(ok({ goals: ["build_muscle", "lose_fat", "mobility"] }).goals).toEqual([
      "build_muscle",
      "lose_fat",
      "mobility",
    ]);
    // 중복은 거절이 아니라 접는다 — 클라이언트 버그지 사용자 잘못이 아니다.
    expect(ok({ goals: ["lose_fat", "lose_fat"] }).goals).toEqual(["lose_fat"]);
  });

  // 동결된 Flutter 앱(D16)이 계속 보내는 모양이다. 깨지면 그 앱이 400 을 맞는다.
  it("단수 goal 도 받아 goals 로 접는다", () => {
    const { goals: _drop, ...noGoals } = minimal;
    const out = validateProfile({ ...noGoals, goal: "general_fitness" });
    expect("profile" in out && out.profile.goals).toEqual(["general_fitness"]);
  });

  it("days_per_week 는 2–6 정수", () => {
    for (const n of [2, 3, 4, 5, 6]) expect(ok({ days_per_week: n }).days_per_week).toBe(n);
    for (const bad of [1, 7, 3.5, "3", null]) rejected({ days_per_week: bad });
  });

  it("배열 필드의 모양을 강제한다", () => {
    rejected({ equipment: "barbell" });
    rejected({ equipment: [1, 2] });
    rejected({ injuries: [{ note: "아픔" }] }); // region 이 없다
    expect(ok({ injuries: [{ region: "shoulder", note: "회전근" }] }).injuries).toEqual([
      { region: "shoulder", note: "회전근" },
    ]);
  });

  it("레드플래그는 허용목록 밖을 거부한다 — 생성 차단 게이트의 입력이다", () => {
    rejected({ red_flags: { hard: ["made_up_flag"] } });
    expect(ok({ red_flags: { hard: ["pregnancy"] } }).red_flags.hard).toEqual(["pregnancy"]);
  });

  it("profile 이 없거나 객체가 아니면 거부한다", () => {
    for (const bad of [undefined, null, "profile", 42, []]) {
      expect(validateProfile(bad)).toHaveProperty("error");
    }
  });

  it("알 수 없는 필드는 산출물에 실리지 않는다", () => {
    // 클라이언트가 무엇을 더 보내든 확장 엔진이 보는 것은 계약 필드뿐이다.
    const p = ok({ target_load_kg: 100, admin: true } as Record<string, unknown>);
    expect(p).not.toHaveProperty("target_load_kg");
    expect(p).not.toHaveProperty("admin");
  });

  it("지운 preferred_days 를 아직 보내는 클라이언트도 400 을 맞지 않는다 (D22-8)", () => {
    // 계약에서 지웠지만([D22-8]) 동결된 Flutter 라인은 계속 보낼 수 있다.
    // **아는 필드만 골라 새 객체를 만드는 성질**에 기대므로 그 성질을 여기서 잠근다 —
    // 값이 무엇이든(형식이 틀려도) 거부하지 않고 조용히 버려야 한다.
    for (const value of [[0, 3], [0, 7], "월수금", 42, null]) {
      const p = ok({ preferred_days: value } as unknown as Record<string, unknown>);
      expect(p).not.toHaveProperty("preferred_days");
    }
  });

  describe("focus_area (D55 ④ · 040 T3-1) · sex 는 받지 않는다 (2026-09-15)", () => {
    it("없으면 키 자체가 없다", () => {
      expect("focus_area" in ok()).toBe(false);
    });

    it("허용목록 값은 그대로 싣는다", () => {
      expect(ok({ focus_area: "lower" }).focus_area).toBe("lower");
      expect(ok({ focus_area: "balanced" }).focus_area).toBe("balanced");
    });

    it("허용목록 밖·null 은 400 — 보내는 쪽이 키를 빼야 한다", () => {
      for (const bad of ["legs", "", null, 0]) rejected({ focus_area: bad });
    });

    it("성별은 기기에만 — 옛 클라이언트가 보내도 산출물에 실리지 않는다", () => {
      expect("sex" in ok({ sex: "female" })).toBe(false);
    });
  });

  describe("available_days (D46 · D56 ②)", () => {
    it("없으면 키 자체가 없다 — undefined 를 실으면 Firestore 가 저장을 거부한다", () => {
      expect("available_days" in ok()).toBe(false);
    });

    it("정렬하고 중복을 접는다", () => {
      expect(ok({ available_days: [4, 0, 2] }).available_days).toEqual([0, 2, 4]);
      expect(ok({ available_days: [0, 0, 2, 4] }).available_days).toEqual([0, 2, 4]);
    });

    it("주당 일수보다 적으면 거절한다 — 통과시키면 재시도 예산을 다 태운다", () => {
      rejected({ available_days: [0, 2] }); // days_per_week 3
      rejected({ available_days: [0, 0, 2] }); // 접으면 2개
      rejected({ available_days: [] });
    });

    it("0–6 정수 배열만 받는다", () => {
      for (const bad of [[7, 0, 2], [-1, 0, 2], [1.5, 0, 2], "0,2,4", null, 3]) rejected({ available_days: bad });
    });
  });
});
