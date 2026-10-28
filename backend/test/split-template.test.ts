/**
 * 분할 템플릿(D24) — 사용자가 고른 2~5분할이 **실제로 요일 구성을 강제하는지**.
 *
 * 이 파일이 지키는 건 하나다: `split_type` 이 라벨로만 남으면 안 된다는 것.
 * 붙기 전에는 프롬프트가 분할을 언급조차 하지 않았고 코드는 결과에 라벨만
 * 덮어썼다 — 3분할로 표시된 플랜이 실제로는 아무 구성이나 될 수 있었다.
 */
import { describe, expect, it } from "vitest";
import { MIN_DAYS_FOR, SPLIT_PREFS, chooseSplit, splitTemplate } from "../src/data/splits";
import { resolveDraft } from "../src/generation/expand";
import { byId } from "../src/data/exercises";
import type { UserProfile } from "../src/generation/types";

const CHEST = "around_the_worlds";
const TRICEPS = "bench_press_powerlifting";
const LATS = "bent_arm_barbell_pullover";
const BICEPS = "alternate_hammer_curl";
const QUADS = "barbell_full_squat";
const SHOULDERS = "alternating_deltoid_raise";
const ABS = "barbell_ab_rollout";

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 3,
    session_len_min: 45,
    environment: "full_gym",
    equipment: ["barbell", "dumbbell"],
    cardio_pref: "maintain_health",
    cardio_modalities: [],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}

/** 하루 한 종목짜리 최소 draft. `days[i]` = i번째 훈련일에 넣을 종목 id 들. */
function draft(days: string[][]) {
  return {
    schema_version: "1.0",
    split_type: "body_part_3",
    week: days.map((ids, dayIndex) => ({
      day_index: dayIndex,
      session_type: "lift",
      focus: "",
      items: ids.map((id, i) => ({
        kind: "strength",
        exercise_id: id,
        role: i === 0 ? "primary" : "accessory",
        order: i + 1,
        rep_intent: "hypertrophy",
      })),
    })),
  };
}

describe("split templates", () => {
  it("고를 수 있는 분할은 모두 템플릿이 있고, 훈련일 수와 부위 수가 맞는다", () => {
    for (const pref of SPLIT_PREFS) {
      const template = splitTemplate(pref);
      expect(template, pref).not.toBeNull();
      expect(template!.length, pref).toBe(MIN_DAYS_FOR[pref]);
      for (const day of template!) {
        expect(day.label.length, `${pref} 라벨`).toBeGreaterThan(0);
        // 근육 이름이 카탈로그 taxonomy 밖이면 매칭이 조용히 실패한다.
        for (const muscle of day.muscles) {
          expect(MUSCLES_IN_CATALOGUE.has(muscle), `${pref}/${muscle}`).toBe(true);
        }
      }
    }
  });

  it("큰 근육이 축이다 — 가슴·등·하체는 어느 분할에서도 같은 날에 겹치지 않는다", () => {
    for (const pref of SPLIT_PREFS.filter((p) => p !== "upper_lower")) {
      for (const day of splitTemplate(pref)!) {
        const big = ["chest", "lats", "quadriceps"].filter((m) => day.muscles.includes(m));
        expect(big.length, `${pref}/${day.label}`).toBeLessThanOrEqual(1);
      }
    }
  });

  it("삼두는 가슴에, 이두는 등에 붙는다(3·4분할)", () => {
    for (const pref of ["body_part_3", "body_part_4"] as const) {
      const template = splitTemplate(pref)!;
      const chestDay = template.find((d) => d.muscles.includes("chest"))!;
      const backDay = template.find((d) => d.muscles.includes("lats"))!;
      expect(chestDay.muscles, pref).toContain("triceps");
      expect(backDay.muscles, pref).toContain("biceps");
    }
  });

  it("5분할은 큰 근육 넷을 떼어내고 작은 근육을 팔 하루에 몰아넣는다", () => {
    const template = splitTemplate("body_part_5")!;
    expect(template.map((d) => d.label)).toEqual(["가슴", "등", "하체", "어깨", "팔"]);
    expect(template[4].muscles).toEqual(["biceps", "triceps", "forearms"]);
  });
});

describe("chooseSplit", () => {
  it("고른 분할이 이기고, 일수가 모자라면 감당되는 최대 분할로 내린다", () => {
    expect(chooseSplit(5, "body_part_5")).toBe("body_part_5");
    expect(chooseSplit(6, "body_part_3")).toBe("body_part_3"); // 더 쪼개 주지 않는다
    expect(chooseSplit(3, "body_part_5")).toBe("body_part_3");
    expect(chooseSplit(2, "body_part_5")).toBe("upper_lower");
  });

  it("모르는 값은 안 고른 것으로 본다 — 조용한 강등이 일수 규칙을 뒤집으면 안 된다", () => {
    expect(chooseSplit(3, "nonsense" as never)).toBe("full_body");
  });
});

describe("분할 준수 검사", () => {
  it("템플릿대로 짠 주는 통과한다", () => {
    const resolved = resolveDraft(
      draft([[CHEST, TRICEPS], [LATS, BICEPS], [QUADS, SHOULDERS]]),
      profile({ split_pref: "body_part_3" }),
    );
    expect(resolved.splitType).toBe("body_part_3");
    expect(resolved.problems).toEqual([]);
  });

  it("다른 날 부위가 섞이면 문제로 잡는다", () => {
    const resolved = resolveDraft(
      draft([[CHEST, BICEPS], [LATS], [QUADS]]), // 1일차(가슴·삼두)에 이두
      profile({ split_pref: "body_part_3" }),
    );
    expect(resolved.problems.join(" ")).toContain("biceps");
  });

  it("훈련일이 분할 수보다 많으면 앞 부위부터 다시 돈다", () => {
    const ok = resolveDraft(
      draft([[CHEST], [LATS], [QUADS], [TRICEPS]]), // 4일차 = 다시 가슴·삼두
      profile({ days_per_week: 4, split_pref: "body_part_3" }),
    );
    expect(ok.problems).toEqual([]);

    const bad = resolveDraft(
      draft([[CHEST], [LATS], [QUADS], [LATS]]), // 4일차에 등
      profile({ days_per_week: 4, split_pref: "body_part_3" }),
    );
    expect(bad.problems.join(" ")).toContain("lats");
  });

  it("복근은 어느 날에든 되지만 두 날에 흩어지면 안 된다", () => {
    const one = resolveDraft(
      draft([[CHEST, ABS], [LATS], [QUADS]]),
      profile({ split_pref: "body_part_3" }),
    );
    expect(one.problems).toEqual([]);

    const two = resolveDraft(
      draft([[CHEST, ABS], [LATS, ABS], [QUADS]]),
      profile({ split_pref: "body_part_3" }),
    );
    expect(two.problems.join(" ")).toContain("복근");
  });

  it("요일이 중복돼도 그 뒤 요일의 부위가 밀리지 않는다", () => {
    // 리프팅 요일 [0,1,1,3]. 접지 않으면 day 1 이 3번째 슬롯으로 덮여 쓰이고
    // day 3 은 `3 % 3 = 0`(가슴·삼두)이 돼 하체가 통째로 위반으로 잡힌다.
    const d = draft([[CHEST], [LATS], [LATS], [QUADS]]) as {
      week: { day_index: number }[];
    };
    d.week[2].day_index = 1; // 중복 — 그 자체는 별도 problem 이다
    const problems = resolveDraft(d, profile({ days_per_week: 4, split_pref: "body_part_3" })).problems;
    expect(problems.some((p) => p.includes("duplicate day_index"))).toBe(true);
    expect(problems.some((p) => p.includes("quadriceps"))).toBe(false);
  });

  it("분할을 고르지 않았으면 부위 규칙을 소급 적용하지 않는다", () => {
    // 홈짐·맨몸·동결 Flutter 앱 경로. 여기서 규칙이 돌면 잘 나오던 생성이 깨진다.
    const resolved = resolveDraft(draft([[CHEST, BICEPS, QUADS], [LATS], [SHOULDERS]]), profile());
    expect(resolved.splitType).toBe("full_body");
    expect(resolved.problems).toEqual([]);
  });

  it("사용자가 직접 넣은 종목은 보지 않는다(D20-1)", () => {
    const d = draft([[CHEST], [LATS], [QUADS]]) as {
      week: { items: Record<string, unknown>[] }[];
    };
    d.week[0].items.push({ kind: "strength", exercise_id: BICEPS, role: "accessory", order: 2, user_pick: true });
    expect(resolveDraft(d, profile({ split_pref: "body_part_3" })).problems).toEqual([]);
  });
});

/** 카탈로그가 실제로 쓰는 주근육 이름들 — 템플릿 오타를 잡는 유일한 근거다. */
const MUSCLES_IN_CATALOGUE = new Set(
  [CHEST, TRICEPS, LATS, BICEPS, QUADS, SHOULDERS, ABS]
    .flatMap((id) => byId(id)?.primary_muscles ?? [])
    .concat([
      "middle back",
      "lower back",
      "traps",
      "hamstrings",
      "glutes",
      "calves",
      "abductors",
      "adductors",
      "forearms",
      "neck",
    ]),
);
