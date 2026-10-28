/**
 * Phase 1 programming constants — CODE OWNS EVERY NUMBER HERE (INV-1).
 * The LLM never produces or sees these values.
 *
 * Source of truth: docs/specs/features/001-weekly-plan-generation/design.md
 * §3.2.1, anchored on the volume landmarks in docs/research/03-ai-plan-
 * generation.md. Tunable once real data accumulates — design.md §3.2.1 calls
 * these "초기 상수". A test asserts they still match the design doc.
 */

/** Cap groups used for weekly volume accounting (design §3.2.1). */
export type CapGroup =
  | "chest"
  | "back"
  | "quads"
  | "hamstrings"
  | "glutes"
  | "shoulders"
  | "biceps"
  | "triceps"
  | "calves";

/**
 * Beginner weekly hard-set ceiling per cap group (sets/week) — design §3.2.1,
 * the conservative beginner value = lower end of MAV in research/03.
 */
export const WEEKLY_VOLUME_CAPS: Record<CapGroup, number> = {
  chest: 12,
  back: 14,
  quads: 12,
  hamstrings: 10,
  glutes: 12,
  shoulders: 12,
  biceps: 10,
  triceps: 10,
  calves: 12,
};

/**
 * MEV anchor (beginner floor) per cap group — research/03 volume landmarks,
 * **lower bound** of the MEV column. Allocation starts here and grows toward
 * cap. Where research splits a group, the lower of the two is taken so the
 * starting volume is the conservative one:
 *   chest 8 · 등(광배) 8 / 등(로우) 6 → back 12 · 대퇴사두 6–10 → 6
 *   햄스트링 4–6 → 4 · 둔근 4 · 측/후면 삼각 6–8 → 6 (전면 삼각 0)
 *   이두 6–8 → 6 · 삼두 4–6 → 4 · 종아리 6–8 → 6
 */
export const MEV_ANCHORS: Record<CapGroup, number> = {
  chest: 8,
  // 등은 광배·중부 등 두 근육이 한 그룹이다 — 하나만 세면(6) 밀기(가슴 8 + 어깨 6)의 절반이 돼 「당기기 ≥ 밀기」
  // (D104 ④ · 백로그 운동목록 12 §1)가 깨진다. 두 하한의 합(14 = 상한) 바로 아래로 둔다.
  back: 12,
  quads: 6,
  hamstrings: 4,
  glutes: 4,
  shoulders: 6,
  biceps: 6,
  triceps: 4,
  calves: 6,
};

/** Double-progression load increment (kg) — design §3.2.1. */
export const LOAD_INCREMENT_KG = { upper: 2.5, lower: 5 } as const;

/**
 * 입문자(`beginner`) 바벨 증량 — design §3.2.1 · D55 ①. NSCA 는 소형·초보자에게
 * 상체 2.5–5lb · 하체 5–10lb 를 권한다(research/03 §초보자·성별 배려); 2.5/5kg 은
 * 그 범위의 상단이라 입문자는 절반으로 간다. 1.25 원판이 없는 헬스장이 있다는
 * 점은 알고 고른 값이다 — 없으면 사용자가 기록에서 고친다.
 */
export const BEGINNER_LOAD_INCREMENT_KG = { upper: 1.25, lower: 2.5 } as const;

/**
 * 덤벨·케틀벨은 **경험 무관하게** 증량 2kg · 격자 1kg (D55 ①). 2kg 격자로 두면
 * 0 기준 반올림이라 3+2 가 6 이 된다 — 시작값 1·3·5 를 지키려면 격자는 1 이어야 한다.
 */
export const HAND_LOAD = { incrementKg: 2, stepKg: 1 } as const;
const HAND_EQUIPMENT = new Set(["dumbbell", "kettlebells"]);
/** 원판을 끼우는 바 — 입문자 1.25/2.5 증량은 여기에만 붙는다(D55 ① 은 바벨을 말한다). 머신·케이블 스택은 종전 2.5/5. */
const BAR_EQUIPMENT = new Set(["barbell", "e-z curl bar"]);

/** Default hypertrophy rep range (초중급) — design §3.2.1. */
export const WORKING_REP_RANGE = { min: 8, max: 12 } as const;

/**
 * 입문자 근비대 렙 범위 — design §3.2.1 · D55 ①. ACSM 2026 초보 권고(12–15렙 ·
 * 50–70% 1RM · 2–3 RIR). hypertrophy 만 바뀐다 — strength·endurance 는 경험 무관.
 */
export const BEGINNER_WORKING_REP_RANGE = { min: 10, max: 15 } as const;

/**
 * 역할별 근비대 렙(D104 ② — D55 ① 의 「입문자 10–15 한 줄」을 대체). 복합은 낮게, 고립은 높게.
 * 근거: ACSM 2009 초급 8–12 · GZCLP T1/T2/T3 · GBR 6–8/10–12/12–15 — 백로그 운동목록 12 §4.
 * `mechanic` 이 없는 종목은 위 두 상수(경험별 한 줄)를 그대로 쓴다.
 */
export const ROLE_REP_RANGES = {
  beginner: { compound: { min: 8, max: 12 }, isolation: { min: 10, max: 15 } },
  novice_intermediate: { compound: { min: 5, max: 10 }, isolation: { min: 8, max: 15 } },
} as const;

/** Warmup sets on the first compound of a session — design §3.2.1. */
export const WARMUP_SETS = { min: 1, max: 2 } as const;

/** Cardio placement rules — design §3.2.1 / FR-GEN-5 / research/03 §3. */
export const CARDIO_RULES = {
  /** Preferred modalities: least interference with lifting. */
  preferredModalities: ["cycling", "rowing"] as const,
  /** LISS: after lifting or on rest days. */
  lissSessionsPerWeek: { min: 2, max: 3 },
  /** HIIT: at most twice a week, never on a heavy-lower day. */
  hiitMaxPerWeek: 2,
  avoidHiitOnHeavyLowerDay: true,
  /** When lifting and cardio share a session: lift first, separate if possible. */
  liftBeforeCardio: true,
  preferredSeparationHours: 3,
} as const;

/**
 * Weekly cardio dose per preference (research/03 §3: "주 2–4세션 = LISS 2–3 +
 * 선택 HIIT 1", LISS 20–40분, HIIT 15–20분).
 *
 * Note this sits **below** the ACSM general-health floor of ≥150 min/week of
 * moderate activity — research/03's own lifter prescription does too, because
 * lifting volume and beginner adherence come first. Raising the dose is a
 * product decision, not a code tweak.
 */
export const CARDIO_DOSE = {
  none: { lissSessions: 0, lissMin: 0, hiitSessions: 0, hiitMin: 0 },
  maintain_health: { lissSessions: 3, lissMin: 30, hiitSessions: 0, hiitMin: 0 },
  fat_loss: { lissSessions: 3, lissMin: 35, hiitSessions: 0, hiitMin: 0 },
  conditioning: { lissSessions: 2, lissMin: 25, hiitSessions: 1, hiitMin: 18 },
} as const;

/** Cap groups that carry a ceiling. Muscles outside this set are uncapped. */
export const CAP_GROUPS = Object.keys(WEEKLY_VOLUME_CAPS) as CapGroup[];

/**
 * Lower-body muscles, in the catalogue's 17-value taxonomy. Used **only** to pick
 * the load increment — deliberately separate from the volume cap roll-up, which
 * answers a different question (a deadlift's `lower back` rolls up to the `back`
 * cap group but still deserves the lower-body +5 kg step).
 */
const LOWER_BODY_MUSCLES = new Set([
  "quadriceps",
  "hamstrings",
  "glutes",
  "calves",
  "abductors",
  "adductors",
  "lower back",
]);

export type ExperienceLevel = "beginner" | "novice_intermediate";

/**
 * Double-progression increment for an exercise, by the muscles it trains.
 * 장비·경험은 선택 인자다 — 안 주면 종전(초중급 바벨) 값 그대로라 기존 호출처가
 * 그대로 돈다. 덤벨·케틀벨은 경험 무관하게 2kg (D55 ①).
 */
export function incrementForMuscles(primaryMuscles: string[], equipment?: string, level?: ExperienceLevel): number {
  if (equipment !== undefined && HAND_EQUIPMENT.has(equipment)) return HAND_LOAD.incrementKg;
  const isLower = primaryMuscles.some((muscle) => LOWER_BODY_MUSCLES.has(muscle));
  // 장비를 모르면 바벨로 본다 — 입문자 표가 적용되는 쪽이 낮은(안전한) 값이다.
  const bar = equipment === undefined || BAR_EQUIPMENT.has(equipment);
  const table = level === "beginner" && bar ? BEGINNER_LOAD_INCREMENT_KG : LOAD_INCREMENT_KG;
  return isLower ? table.lower : table.upper;
}

/**
 * 반올림 격자(kg). **바벨은 격자 = 증량**이다 — 격자가 2.5 인 채로 1.25 를 더하면
 * 반올림이 증량을 삼킨다(20+1.25 → 22.5). 덤벨·케틀벨은 1kg (`HAND_LOAD`).
 * 초중급 바벨은 종전 2.5 그대로(하체 +5 는 2.5 의 배수라 결과가 같다).
 */
export function loadStepFor(primaryMuscles: string[], equipment?: string, level?: ExperienceLevel): number {
  if (equipment !== undefined && HAND_EQUIPMENT.has(equipment)) return HAND_LOAD.stepKg;
  const bar = equipment === undefined || BAR_EQUIPMENT.has(equipment);
  if (level !== "beginner" || !bar) return LOAD_INCREMENT_KG.upper;
  return incrementForMuscles(primaryMuscles, equipment, level);
}

/**
 * Load cut when pain was logged (S-GEN-11). research/03 puts deload intensity at
 * roughly −10%; we reuse that figure rather than inventing a second one. A missed
 * rep target instead steps down by one `LOAD_INCREMENT_KG`, so that path needs no
 * separate percentage at all.
 */
export const PAIN_DELOAD_FACTOR = 0.9;

// ── 입문자 1주차 시작값 (D55 ② · 040 N2) ────────────────────────────────────

/**
 * 입문자 1주차 시작값(kg) — 장비의 **물리적 하한 근처**를 코드 상수로 둔다(D55 ②).
 * 체중×계수는 쓰지 않는다(사용자 판단: 덤벨·바벨이 달라 계수 하나로 안 맞는다).
 * 머신·케이블은 제조사별 눈금이라 없음(null 유지, 「가장 가벼운 핀」 문구) ·
 * `other`(스트롱맨·플라이오)·맨몸은 없음(맨몸은 횟수 처방 — G0 Q1). 근거 등급은
 * 낮지만 「가장 가벼운 물리값」이라 틀릴 방향이 안전 쪽뿐이고, 2주차부터는 사용자가
 * 적은 무게가 기준이 된다(research/03 §초보자·성별 배려).
 */
export const BEGINNER_START_LOAD_KG = {
  /** 빈 바 — 성별 무관. 바보다 가벼울 수 없다. */
  barbell: 20,
  /**
   * 손당. `mechanic: null` 인 덤벨 종목은 고립값(G0 Q3 — 낮은 쪽이 안전).
   * D55 ② 표는 남 5/2 · 여 3/1 이었으나 **성별이 서버에 오지 않으므로**(2026-09-15 사용자 결정,
   * D55 ③ 철회) 낮은 쪽 하나만 둔다. 쉬우면 세션에서 올리고, 적은 무게가 다음 주 기준이다.
   */
  dumbbell: { compound: 3, isolation: 1 },
  kettlebells: 8,
} as const;

/** 이력이 없는 입문자의 시작값. 초중급·표 밖 장비는 `null`. */
export function startLoadFor(
  exercise: { equipment: string; mechanic: "compound" | "isolation" | null },
  level?: ExperienceLevel,
): number | null {
  if (level !== "beginner") return null;
  switch (exercise.equipment) {
    case "barbell":
      return BEGINNER_START_LOAD_KG.barbell;
    case "dumbbell":
      return BEGINNER_START_LOAD_KG.dumbbell[exercise.mechanic === "compound" ? "compound" : "isolation"];
    case "kettlebells":
      return BEGINNER_START_LOAD_KG.kettlebells;
    default:
      return null;
  }
}

/**
 * 장비의 물리적 하한(kg) — 감량이 이 아래로 내려가면 `substitute` 다(D55 ①·②).
 * 바벨은 빈 바보다 가벼울 수 없다. 표에 없는 장비는 격자 한 칸(`loadFloorFor`).
 * 경험 무관 — 17.5kg 바벨은 초중급자에게도 존재하지 않는다.
 */
export const EQUIPMENT_FLOOR_KG: Record<string, number> = { barbell: 20 };

export function loadFloorFor(equipment: string, step: number): number {
  return EQUIPMENT_FLOOR_KG[equipment] ?? step;
}

/**
 * 맨몸 난이도 사다리 — 쉬운 것부터. 맨몸은 kg 대신 렙 → 다음 단계로 진행한다
 * (백로그 `운동목록_및_운동플랜_개선/02` §3 3 · r/bodyweightfitness RR · Convict Conditioning).
 * 카탈로그에 없는 단계(의자 스쿼트·불가리안·피스톨 보조·네거티브 풀업)는 뺐다.
 * 도구가 필요한 단계는 진행 때 보유 도구로 건너뛴다(`nextBodyweightStep` 의 `allowed`).
 */
export const BODYWEIGHT_LADDERS: readonly (readonly string[])[] = [
  ["wall_push_up", "incline_push_up", "knee_push_up", "pushups", "push_ups_close_triceps_position", "push_ups_with_feet_elevated"],
  // 로우와 풀업은 다른 패턴(수평/수직 당기기)이라 사다리를 잇지 않는다 — r/bodyweightfitness RR 도 따로 둔다.
  // 이으면 P1 의 수평 당기기 슬롯이 풀업으로 바뀌어 주간 패턴이 깨진다(codex N8b R1).
  ["towel_door_row", "table_inverted_row"],
  ["bodyweight_squat", "split_squats"],
];
