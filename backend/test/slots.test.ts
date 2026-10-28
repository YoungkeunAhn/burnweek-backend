import { describe, expect, it } from "vitest";
import { byId, contraindicationTags } from "../src/data/exercises";
import { splitTemplate } from "../src/data/splits";
import { expandDraftToWeeklyPlan } from "../src/generation/expand";
import { repRangeFor } from "../src/generation/loading";
import { MEDICAL_DISCLAIMER } from "../src/generation/safety";
import { buildSkeleton, patternOf, SESSION_EXERCISES, slotCandidates, type Pattern } from "../src/generation/slots";
import type { UserProfile } from "../src/generation/types";

// P1 골격(실행 그래프 N8a · D104) — 슬롯·순서·종목 수·역할·렙.

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

const COMPOUND = new Set<Pattern>(["squat", "hinge", "lunge", "glute", "h_push", "v_push", "h_pull", "v_pull"]);
const PUSH = new Set<Pattern>(["h_push", "v_push"]);
const PULL = new Set<Pattern>(["h_pull", "v_pull"]);

describe("골격 — 분할·패턴 (T8-1)", () => {
  for (const days of [2, 3, 4, 5, 6] as const) {
    it(`${days}일: 날마다 종목 수 · 주간 6패턴 · 복합 먼저 · 밀기:당기기 0.75–1.34`, () => {
      const week = buildSkeleton(profile({ days_per_week: days }));
      expect(week).toHaveLength(days);
      const patterns = new Set(week.flatMap((d) => d.slots.map((s) => s.pattern)));
      for (const p of ["squat", "h_push", "v_push", "h_pull", "v_pull"] as Pattern[]) expect(patterns).toContain(p);
      expect(patterns.has("hinge") || patterns.has("glute")).toBe(true);
      let push = 0;
      let pull = 0;
      for (const day of week) {
        expect(day.slots).toHaveLength(SESSION_EXERCISES[45]);
        expect(day.slots[0]!.role).toBe("primary");
        const kinds = day.slots.map((s) => COMPOUND.has(s.pattern));
        expect(kinds).toEqual([...kinds].sort((a, b) => Number(b) - Number(a)));
        push += day.slots.filter((s) => PUSH.has(s.pattern)).length;
        pull += day.slots.filter((s) => PULL.has(s.pattern)).length;
      }
      expect(pull / push).toBeGreaterThanOrEqual(0.75);
      expect(pull / push).toBeLessThanOrEqual(1.34);
    });
  }

  it("2~3일은 전신, 4일은 상·하체 — 분할을 고르지 않았을 때(D104 ①)", () => {
    expect(buildSkeleton(profile({ days_per_week: 2 })).map((d) => d.label)).toEqual(["전신 A", "전신 B"]);
    expect(buildSkeleton(profile({ days_per_week: 4 })).map((d) => d.label)).toEqual(["상체", "하체", "상체", "하체"]);
  });

  it("세션 길이가 웨이트 종목 수를 정한다(D104 ③)", () => {
    expect(buildSkeleton(profile({ session_len_min: 30 }))[0]!.slots).toHaveLength(4);
    expect(buildSkeleton(profile({ session_len_min: 60 }))[0]!.slots).toHaveLength(6);
  });

  it("복근은 주에 한 날에만(D24-1) — 건너뛴 자리는 다음 슬롯이 채워 종목 수가 그대로", () => {
    const week = buildSkeleton(profile({ days_per_week: 4, session_len_min: 90 }));
    expect(week.filter((d) => d.slots.some((s) => s.pattern === "core"))).toHaveLength(1);
    for (const day of week) expect(day.slots).toHaveLength(SESSION_EXERCISES[90]);
    // 이번 주에 이미 복근을 했으면(재생성) 남은 날엔 없다.
    const rest = buildSkeleton(profile({ days_per_week: 2, session_len_min: 90 }), { completed: [{ day_index: 0, exercise_ids: ["crunches"] }] });
    expect(rest.flatMap((d) => d.slots).some((s) => s.pattern === "core")).toBe(false);
  });

  it("입문자 바벨은 그 날 메인 슬롯 후보에만(D55 ① 세션당 1개) · 장비 순위가 먼저", () => {
    for (const day of buildSkeleton(profile({ days_per_week: 4, session_len_min: 90 }))) {
      for (const slot of day.slots.slice(1)) {
        expect(slot.candidates.filter((id) => byId(id)!.equipment === "barbell"), `${day.label} ${slot.key}`).toEqual([]);
      }
    }
    const hinge = slotCandidates("hinge", profile());
    // 머신 SLDL 이 바벨 RDL 보다 앞(바벨은 6개 컷에서 빠지기도 한다).
    const rdl = hinge.indexOf("romanian_deadlift");
    expect(hinge.indexOf("smith_machine_stiff_legged_deadlift")).toBeGreaterThanOrEqual(0);
    expect(rdl === -1 || hinge.indexOf("smith_machine_stiff_legged_deadlift") < rdl).toBe(true);
    expect(byId(slotCandidates("h_pull", profile())[0]!)!.equipment).toBe("machine");
  });

  it("주 패턴 후보가 2개 이상이면 대체 패턴을 섞지 않는다 — 철봉 맨몸의 수직 당기기 슬롯에 로우 없음", () => {
    const week = buildSkeleton(profile({ environment: "bodyweight_only", equipment: ["pull_up_bar"] }));
    const vPull = week.flatMap((d) => d.slots).find((s) => s.pattern === "v_pull")!;
    expect(vPull.candidates.every((id) => patternOf(byId(id)!) === "v_pull")).toBe(true);
  });

  it("사용자가 고른 분할은 그 날 근육 안의 후보만", () => {
    const p = profile({ days_per_week: 3, split_pref: "body_part_3" });
    const template = splitTemplate("body_part_3")!;
    buildSkeleton(p).forEach((day, i) => {
      expect(day.label).toBe(template[i]!.label);
      const allowed = new Set([...template[i]!.muscles, "abdominals", "neck"]);
      for (const id of day.slots.flatMap((s) => s.candidates)) {
        expect(byId(id)!.primary_muscles.every((m) => allowed.has(m)), `${day.label} ${id}`).toBe(true);
      }
    });
  });

  it("부위별 분할도 90분이면 7종목(템플릿 칸이 모자라지 않다)", () => {
    for (const split_pref of ["body_part_3", "body_part_4", "body_part_5"] as const) {
      const days = split_pref === "body_part_5" ? 5 : split_pref === "body_part_4" ? 4 : 3;
      for (const day of buildSkeleton(profile({ split_pref, days_per_week: days, session_len_min: 90, focus_area: "upper" }))) {
        expect(day.slots.length, `${split_pref} ${day.label}`).toBeGreaterThanOrEqual(SESSION_EXERCISES[90]);
      }
    }
  });

  it("중점 하체면 하체가 있는 날에 둔근 슬롯이 하나 더(D55 ④)", () => {
    for (const day of buildSkeleton(profile({ focus_area: "lower" }))) {
      expect(day.slots.map((s) => s.pattern)).toContain("glute");
      expect(day.slots).toHaveLength(SESSION_EXERCISES[45] + 1);
    }
  });

  it("입문자는 근력 목표여도 strength 렙이 없다 · 초중급 근력 목표는 메인만 strength (D104 ②)", () => {
    const beginner = buildSkeleton(profile({ goals: ["gain_strength"] }));
    expect(beginner.flatMap((d) => d.slots).every((s) => s.repIntent === "hypertrophy")).toBe(true);
    const novice = buildSkeleton(profile({ goals: ["gain_strength"], experience_level: "novice_intermediate" }));
    for (const day of novice) {
      expect(day.slots[0]!.repIntent).toBe("strength");
      expect(day.slots.slice(1).every((s) => s.repIntent === "hypertrophy")).toBe(true);
    }
  });
});

describe("슬롯 후보 (T8-2 · T8-5)", () => {
  it("큐레이션 순위 — 헬스장 스쿼트계 1순위는 레그프레스, 랫풀다운·시티드 로우도 1순위(초중급 — 입문자는 장비 순위가 먼저)", () => {
    const p = profile({ experience_level: "novice_intermediate" });
    expect(slotCandidates("squat", p)[0]).toBe("leg_press");
    expect(slotCandidates("v_pull", p)[0]).toBe("wide_grip_lat_pulldown");
    expect(slotCandidates("h_pull", p)[0]).toBe("seated_cable_rows");
  });

  it("맨몸·도구 없음: 후보에 requires 0 · 수직 당기기는 수평 당기기로 대체", () => {
    const p = profile({ environment: "bodyweight_only", equipment: [] });
    const week = buildSkeleton(p);
    const ids = week.flatMap((d) => d.slots.flatMap((s) => s.candidates));
    expect(ids.filter((id) => (byId(id)!.requires ?? []).length > 0)).toEqual([]);
    expect(ids).toContain("pushups");
    expect(week.flatMap((d) => d.slots.map((s) => s.pattern))).not.toContain("v_pull");
    // 힌지 후보가 하나뿐이면 둔근 브릿지가 뒤에 붙는다.
    const hinge = week[0]!.slots.find((s) => s.pattern === "hinge")!;
    expect(hinge.candidates.length).toBeGreaterThan(1);
  });

  it("직전 주 종목은 같은 패턴 슬롯의 1순위(연속성)", () => {
    const week = buildSkeleton(profile({ experience_level: "novice_intermediate" }), { recent: ["barbell_squat"] });
    expect(week[0]!.slots.find((s) => s.pattern === "squat")!.candidates[0]).toBe("barbell_squat");
  });

  it("부상 부위를 쓰는 종목은 후보에 없다", () => {
    const p = profile({ injuries: [{ region: "shoulders" }] });
    for (const id of buildSkeleton(p).flatMap((d) => d.slots.flatMap((s) => s.candidates))) {
      expect(contraindicationTags(byId(id)!)).not.toContain("shoulders");
    }
  });

  it("패턴 분류 — 점프·올림픽 리프트는 슬롯이 아니다", () => {
    expect(patternOf(byId("power_clean")!)).toBeNull();
    expect(patternOf(byId("freehand_jump_squat")!)).toBeNull();
    expect(patternOf(byId("leg_press")!)).toBe("squat");
    expect(patternOf(byId("seated_leg_curl")!)).toBe("leg_curl");
  });
});

describe("역할별 렙 (D104 ②)", () => {
  it("경험 × 복합/고립", () => {
    expect(repRangeFor("hypertrophy", "beginner", "compound")).toEqual({ min: 8, max: 12 });
    expect(repRangeFor("hypertrophy", "beginner", "isolation")).toEqual({ min: 10, max: 15 });
    expect(repRangeFor("hypertrophy", "novice_intermediate", "compound")).toEqual({ min: 5, max: 10 });
    expect(repRangeFor("hypertrophy", "novice_intermediate", "isolation")).toEqual({ min: 8, max: 15 });
    // 역할이 없는 종목은 경험별 한 줄(D55 ①) 그대로.
    expect(repRangeFor("hypertrophy", "beginner", null)).toEqual({ min: 10, max: 15 });
  });

  it("입문자 AI 드래프트의 strength 는 근비대로 · 사용자 편집(user_pick)의 strength 는 그대로", () => {
    const run = (userPick: boolean) =>
      expandDraftToWeeklyPlan({
        draft: {
          schema_version: "1.0",
          split_type: "full_body",
          week: [0, 2, 4].map((day_index) => ({
            day_index,
            session_type: "lift",
            focus: "",
            items: [{ kind: "strength", exercise_id: "barbell_squat", role: "primary", order: 1, rep_intent: "strength", ...(userPick ? { user_pick: true } : {}) }],
          })),
        },
        profile: profile(),
        userId: "u1",
        weekStartDate: "2026-08-17",
        weekNumber: 1,
        priorLogs: [],
        disclaimer: MEDICAL_DISCLAIMER,
      });
    const reps = (r: ReturnType<typeof run>) => {
      const sets = (r.plan as { week: Array<{ exercises: Array<{ sets?: Array<{ set_kind: string; target_reps_high: number }> }> }> }).week
        .flatMap((d) => d.exercises)
        .flatMap((e) => (e.sets ?? []).filter((s) => s.set_kind === "working"));
      return new Set(sets.map((s) => s.target_reps_high));
    };
    expect(reps(run(false))).toEqual(new Set([12]));
    expect(reps(run(true))).toEqual(new Set([5]));
  });
});

describe("N9 실측 반영 — 다양성 · 부상 슬롯", () => {
  it("후보가 1개뿐인 슬롯은 만들지 않는다(어깨 부상에 플라이 하나로 수평 밀기를 채우지 않는다)", () => {
    const week = buildSkeleton(profile({ environment: "minimal", equipment: ["dumbbell", "body only"], injuries: [{ region: "shoulders" }] }));
    for (const s of week.flatMap((d) => d.slots)) expect(s.candidates.length, `${s.key} ${s.pattern}`).toBeGreaterThanOrEqual(2);
  });

  it("같은 패턴이 주에 다시 나오면(메인 제외) 기본 선택이 달라진다 — 날마다 다른 변형", () => {
    const week = buildSkeleton(profile({ days_per_week: 3 }));
    // 3일 = A·B·A — A 의 보조 슬롯(수평 밀기·수직 당기기)이 첫날과 셋째 날 다른 운동으로 시작한다.
    const first = (d: number, p: Pattern) => week[d]!.slots.find((s) => s.pattern === p && s.role !== "primary")?.candidates[0];
    expect(first(0, "h_push")).not.toBe(first(2, "h_push"));
    expect(first(0, "v_pull")).not.toBe(first(2, "v_pull"));
    // 메인은 그대로(숙련).
    expect(week[0]!.slots[0]!.candidates[0]).toBe(week[2]!.slots[0]!.candidates[0]);
  });

  it("맨몸 하루에 같은 기본 운동이 두 슬롯에 오지 않는다", () => {
    for (const day of buildSkeleton(profile({ environment: "bodyweight_only", equipment: [] }))) {
      const firsts = day.slots.map((s) => s.candidates[0]);
      expect(new Set(firsts).size, day.label).toBe(firsts.length);
    }
  });
});

describe("N9 실측 보정 — 덤벨 홈짐", () => {
  it("부상이 없으면 후보 1개 슬롯도 둔다(덤벨 홈짐 힌지) · 대체 로우와 원래 로우가 겹치지 않는다", () => {
    const week = buildSkeleton(profile({ environment: "home_gym", equipment: ["dumbbell"] }));
    for (const day of week) {
      expect(day.slots.some((s) => s.pattern === "hinge" || s.pattern === "glute"), day.label).toBe(true);
      expect(day.slots.filter((s) => s.pattern === "h_pull").length, day.label).toBeLessThanOrEqual(1);
    }
  });
});

describe("codex N9 R1 — 보정 규칙의 부작용", () => {
  it("부상과 무관한 유일 후보는 남는다(덤벨 홈짐 + 목 부상 → 힌지 유지)", () => {
    const week = buildSkeleton(profile({ environment: "home_gym", equipment: ["dumbbell"], injuries: [{ region: "neck" }] }));
    expect(week.some((d) => d.slots.some((s) => s.pattern === "hinge"))).toBe(true);
  });

  it("건너뛴 자리는 보충해 종목 수를 지킨다 — 맨몸 3일 45분은 날마다 5종목", () => {
    for (const day of buildSkeleton(profile({ environment: "bodyweight_only", equipment: [] }))) {
      expect(day.slots, day.label).toHaveLength(SESSION_EXERCISES[45]);
    }
  });

  it("같은 날 두 슬롯의 기본 운동이 겹치지 않는다 — 맨몸 4일 30분 하체 중점", () => {
    for (const day of buildSkeleton(profile({ environment: "bodyweight_only", equipment: [], days_per_week: 4, session_len_min: 30, focus_area: "lower" }))) {
      const firsts = day.slots.map((s) => s.candidates[0]);
      expect(new Set(firsts).size, day.label).toBe(firsts.length);
    }
  });
});

describe("codex N9 R2", () => {
  it("분할·바벨 제한만으로 1개인 슬롯은 부상이 있어도 남는다 · 후면 레터럴 레이즈는 후면 어깨", () => {
    const withInjury = buildSkeleton(profile({ environment: "home_gym", equipment: ["barbell", "body only"], days_per_week: 2, session_len_min: 60, split_pref: "upper_lower", injuries: [{ region: "neck" }] }));
    const without = buildSkeleton(profile({ environment: "home_gym", equipment: ["barbell", "body only"], days_per_week: 2, session_len_min: 60, split_pref: "upper_lower" }));
    // 목 부상은 이 날 후보를 줄이지 않는다 — 슬롯 패턴이 부상 없을 때와 같아야 한다(보충이 채워 종목 수만으로는 안 보인다).
    expect(withInjury.map((d) => d.slots.map((x) => x.pattern))).toEqual(without.map((d) => d.slots.map((x) => x.pattern)));
    expect(patternOf(byId("dumbbell_lying_rear_lateral_raise")!)).toBe("rear_delt");
  });

  it("맨몸 4일 45분 상체 날도 목표 종목 수를 채운다(있는 패턴의 다른 운동으로)", () => {
    for (const day of buildSkeleton(profile({ environment: "bodyweight_only", equipment: [], days_per_week: 4 }))) {
      expect(day.slots.length, day.label).toBe(SESSION_EXERCISES[45]);
      const firsts = day.slots.map((s) => s.candidates[0]);
      expect(new Set(firsts).size, day.label).toBe(firsts.length);
    }
  });
});

describe("codex N9 R3", () => {
  it("반복 보충은 더 채울 수 없을 때까지 — 맨몸 4일 90분 상체 날도 7종목", () => {
    for (const day of buildSkeleton(profile({ environment: "bodyweight_only", equipment: [], days_per_week: 4, session_len_min: 90 }))) {
      if (day.label === "상체") expect(day.slots.length, day.label).toBe(SESSION_EXERCISES[90]);
    }
  });

  it("자동 5일 분할의 보충은 그 날 부위 안 — 상체·밀기 날에 하체 운동 없음", () => {
    const week = buildSkeleton(profile({ environment: "bodyweight_only", equipment: [], days_per_week: 5 }));
    const legs = new Set(["quadriceps", "hamstrings", "glutes", "calves", "abductors", "adductors"]);
    for (const day of week.filter((d) => d.label === "상체" || d.label === "밀기")) {
      for (const id of day.slots.flatMap((s) => s.candidates)) {
        expect(byId(id)!.primary_muscles.some((m) => legs.has(m)), `${day.label} ${id}`).toBe(false);
      }
    }
  });
});

describe("codex N9 R4", () => {
  it("보충 목록은 모든 패턴 — 3분할 가슴·삼두 날 + 삼두 부상도 90분이면 7종목", () => {
    const week = buildSkeleton(profile({ days_per_week: 3, session_len_min: 90, split_pref: "body_part_3", injuries: [{ region: "triceps" }] }));
    expect(week[0]!.label).toBe("가슴·삼두");
    expect(week[0]!.slots.length).toBe(SESSION_EXERCISES[90]);
  });
});

describe("codex N9 R5", () => {
  it("슬롯 후보에는 같은 날 다른 슬롯의 기본 운동이 없다 — 어떤 후보를 골라도 다른 슬롯이 밀려나지 않는다", () => {
    for (const p of [profile({ environment: "bodyweight_only", equipment: [], days_per_week: 4, session_len_min: 90 }), profile({ days_per_week: 3 })]) {
      for (const day of buildSkeleton(p)) {
        const defaults = day.slots.map((s) => s.candidates[0]);
        for (const s of day.slots) expect(s.candidates.slice(1).filter((id) => defaults.includes(id)), `${day.label} ${s.key}`).toEqual([]);
      }
    }
  });

  it("반복 보충은 이미 고른 운동을 빼고 자른다 — 5분할 팔 날 + 이두 부상도 90분이면 7종목", () => {
    const week = buildSkeleton(profile({ days_per_week: 5, session_len_min: 90, split_pref: "body_part_5", injuries: [{ region: "biceps" }] }));
    const arms = week.find((d) => d.label === "팔")!;
    expect(arms.slots.length).toBe(SESSION_EXERCISES[90]);
  });
});

describe("codex N9 R6", () => {
  it("당기기 날 보충에 밀기가 없다 · 밀기 날 보충에 당기기가 없다(덤벨 홈짐 6일 90분 이두 부상)", () => {
    const week = buildSkeleton(profile({ environment: "home_gym", equipment: ["dumbbell"], days_per_week: 6, session_len_min: 90, injuries: [{ region: "biceps" }] }));
    for (const d of week.filter((x) => x.label === "당기기")) expect(d.slots.map((s) => s.pattern).filter((p) => ["h_push", "v_push", "chest_iso", "triceps"].includes(p)), d.label).toEqual([]);
    for (const d of week.filter((x) => x.label === "밀기")) expect(d.slots.map((s) => s.pattern).filter((p) => ["h_pull", "v_pull", "biceps"].includes(p)), d.label).toEqual([]);
  });

  it("부상 판정도 이미 고른 운동을 같은 조건으로 뺀다 — 맨몸 4일 90분 목 부상도 날마다 목표에 가깝게", () => {
    const withInjury = buildSkeleton(profile({ environment: "bodyweight_only", equipment: [], days_per_week: 4, session_len_min: 90, injuries: [{ region: "neck" }] }));
    const without = buildSkeleton(profile({ environment: "bodyweight_only", equipment: [], days_per_week: 4, session_len_min: 90 }));
    expect(withInjury.map((d) => d.slots.length)).toEqual(without.map((d) => d.slots.length));
  });
});

describe("codex N9 R7", () => {
  it("겹치는 대체 패턴은 같은 쪽으로 바꿔 넣는다 — 덤벨 홈짐 2일 45분, 주간 당기기 슬롯 ≥ 밀기 슬롯", () => {
    const week = buildSkeleton(profile({ environment: "home_gym", equipment: ["dumbbell"], days_per_week: 2 }));
    const all = week.flatMap((d) => d.slots.map((s) => s.pattern));
    const push = all.filter((p) => ["h_push", "v_push", "chest_iso", "triceps"].includes(p)).length;
    const pull = all.filter((p) => ["h_pull", "v_pull", "rear_delt", "biceps"].includes(p)).length;
    expect(pull).toBeGreaterThanOrEqual(push);
  });
});

describe("codex N9 R8", () => {
  it("첫 슬롯 대체는 바꾸지 않는다 — 바벨만 홈짐 입문 6일 당기기 날 메인은 로우", () => {
    const week = buildSkeleton(profile({ environment: "home_gym", equipment: ["barbell"], days_per_week: 6 }));
    for (const d of week.filter((x) => x.label === "당기기")) expect(d.slots[0]!.pattern, d.label).toBe("h_pull");
  });
});
