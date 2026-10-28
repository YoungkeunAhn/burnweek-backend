/**
 * Cardio placement — code owns duration, zone and placement (INV-1, S-GEN-6).
 *
 * The LLM may propose a modality/style (`DraftPlan.items[].cardio_kind`); every
 * number, equipment constraint and the interference rules come from here.
 *
 * Grounding: research/03 §3 "웨이트 + 유산소 결합" — running interferes (Type I
 * SMD −0.81) while cycling/rowing/elliptical/incline walking are near-negligible;
 * LISS = Zone 2 (60–70% HRmax) 20–40 min; HIIT = 15–20 min on bike/rower, ≤2–3×
 * per week, never adjacent to heavy squats/deadlifts; ≥3 h separation removes most
 * interference. design §3.2.1 fixes the Phase 1 choices.
 */
import { CARDIO_DOSE, CARDIO_RULES } from "../data/constants";
import type { DraftStrengthItem } from "./expand";
import type { UserProfile } from "./types";

export type CardioModality = "cycling" | "rowing" | "elliptical" | "incline_walk" | "running" | "stairs";
export type CardioStyle = "LISS" | "HIIT";
export type CardioPlacement = "after_lifting" | "separate_session" | "rest_day";

export interface CardioSession {
  dayIndex: number;
  modality: CardioModality;
  style: CardioStyle;
  durationMin: number;
  intensityZone: string;
  placement: CardioPlacement;
  /** 환경에 맞게 코드가 고르거나 사용자가 고른 운동 id — 없으면 분류의 기본 id(041 N4). */
  exerciseId?: string;
  /** 사용자가 정한 목표 칸([D57] A1·A9). 없으면 도스 그대로다. */
  extra?: CardioTargetExtra;
}

/** 목표 중 방식·총 시간 말고 운동별 칸(계획 `cardio_detail` 선택 필드). */
export interface CardioTargetExtra {
  distance_m?: number;
  incline_pct?: number;
  level?: number;
  segments?: CardioSegment[];
}

export interface CardioPlan {
  sessions: CardioSession[];
  /** Adjustments made to satisfy the interference rules — surfaced to the user. */
  notes: string[];
}

/** WeeklyPlan v1 `cardio_detail` (02-data-model §B2) — snake_case, exact fields. 목표 칸은 선택(041 N4). */
export interface CardioDetail extends CardioTargetExtra {
  modality: CardioModality;
  style: CardioStyle;
  duration_min: number;
  intensity_zone: string;
  placement: CardioPlacement;
}

/** Internal session → the contract shape. Keeps the naming gap from biting B6. */
export function toCardioDetail(session: CardioSession): CardioDetail {
  return {
    modality: session.modality,
    style: session.style,
    duration_min: session.durationMin,
    intensity_zone: session.intensityZone,
    placement: session.placement,
    ...session.extra,
  };
}

const ZONE = {
  LISS: "Zone 2 (최대심박 60–70%)",
  HIIT: "인터벌 (최대심박 85–95% 구간 반복)",
} as const;

const ALL_MODALITIES: CardioModality[] = ["cycling", "rowing", "elliptical", "incline_walk", "running", "stairs"];

/**
 * 모달리티 ↔ 카탈로그 id. **정본은 이 한 벌이다** — 확장(`expand.ts`)·편집(`edit.ts`)·미니앱
 * 유산소 시트(`plan.tsx`)가 같이 읽는다. 이 파일에 둔 이유는 미니앱 번들이 확장 엔진을 끌고 오지 않게.
 */
export const CARDIO_EXERCISE_IDS: Record<CardioModality, string> = {
  cycling: "bicycling_stationary",
  rowing: "rowing_stationary",
  elliptical: "elliptical_trainer",
  incline_walk: "walking_treadmill",
  running: "running_treadmill",
  stairs: "stairmaster",
};

/** Cardio modality → a catalogue exercise, so the plan's ids stay real. */
export function cardioExerciseId(modality: string): string {
  return CARDIO_EXERCISE_IDS[modality as CardioModality] ?? "bicycling_stationary";
}

/** `cardioExerciseId` 의 역. 플랜의 유산소 줄 id 로 편집이 모달리티를 되찾는다(백로그 030 §1.1). */
export function modalityOfCardioExercise(id: string): CardioModality | undefined {
  return ALL_MODALITIES.find((m) => CARDIO_EXERCISE_IDS[m] === id);
}

/** 설정 방식([D57] A4) — 유산소 운동마다 어떤 칸을 받는지. 화면은 이 이름으로 칸을 고른다. */
export type CardioForm = "run" | "walk" | "level" | "distance" | "time";
type Range = readonly [number, number];

export interface CardioExerciseSpec {
  /** 생성 배치용 내부 분류([D57] A3) — 스키마 `cardio.modality` 에 실린다. */
  modality: CardioModality;
  form: CardioForm;
  /** 있으면 그 칸의 범위([D57] A12), 없으면 그 운동에는 칸이 없다. */
  incline?: Range;
  speed?: Range;
}

const TREADMILL = { incline: [-3, 20], speed: [0.5, 30] } as const;

/**
 * 유산소 13종의 설정 방식 표([D57] A2·A4·A12 · 041 G0 Q5). **정본은 이 한 벌이다** — 세션 `PUT`·
 * 편집·미니앱 입력 칸이 같이 읽는다. 거리·레벨 칸 유무는 `form` 이 정한다.
 */
export const CARDIO_EXERCISES: Record<string, CardioExerciseSpec> = {
  running_treadmill: { modality: "running", form: "run", ...TREADMILL },
  jogging_treadmill: { modality: "running", form: "run", ...TREADMILL },
  trail_running_walking: { modality: "running", form: "run", speed: [0.5, 30] },
  walking_treadmill: { modality: "incline_walk", form: "walk", ...TREADMILL },
  mymountain: { modality: "incline_walk", form: "walk", incline: [-5, 50], speed: [0.5, 10] },
  bicycling_stationary: { modality: "cycling", form: "level" },
  recumbent_bike: { modality: "cycling", form: "level" },
  elliptical_trainer: { modality: "elliptical", form: "level" },
  stairmaster: { modality: "stairs", form: "level" },
  step_mill: { modality: "stairs", form: "level" },
  bicycling: { modality: "cycling", form: "distance" },
  rowing_stationary: { modality: "rowing", form: "distance" },
  rope_jumping: { modality: "running", form: "time" },
};

export function cardioFormOf(exerciseId: string): CardioExerciseSpec | undefined {
  return CARDIO_EXERCISES[exerciseId];
}

/**
 * 이 운동이 받는 칸([D57] A3·A4·A12) — 범위 판정과 입력 화면(미니앱 `cardio-input.tsx`)이 같이 읽는다.
 * 표에 없는 id(옛 기록)는 옛 칸(시간·거리)만 받는다.
 */
export function cardioFieldsOf(exerciseId: string) {
  const spec = CARDIO_EXERCISES[exerciseId];
  const form = spec?.form;
  return {
    distance: !spec || form === "run" || form === "walk" || form === "distance",
    incline: spec?.incline,
    speed: spec?.speed,
    level: form === "level",
    segments: Boolean(spec),
  };
}

/** 실측 `cardio` 와 계획 목표가 같이 쓰는 칸 묶음([D57] A9). */
export interface CardioSegment {
  label?: string;
  sec: number;
  speed_kmh?: number;
  incline_pct?: number;
  level?: number;
}

export interface CardioFields {
  style?: CardioStyle;
  duration_min?: number;
  distance_m?: number | null;
  incline_pct?: number | null;
  level?: number | null;
  /** 기록에만 있다([D77]) — 총 시간의 초(0–59). 계획 목표에는 없다. */
  duration_sec?: number | null;
  segments?: CardioSegment[];
}

export const CARDIO_LIMITS = {
  durationMin: [1, 300],
  /** 기록의 총 시간(분) 하한은 0 이다([D77] — 분+초 > 0 을 따로 본다). 계획 목표는 `durationMin` 그대로 1분. */
  recordDurationMin: [0, 300],
  durationSec: [0, 59],
  distanceM: [100, 100_000],
  level: [1, 30],
  segmentSec: [1, 3600],
  segments: [1, 100],
} as const satisfies Record<string, Range>;

/**
 * 유산소 칸의 범위 판정([D57] A12) — 문제 문장 배열, 비었으면 통과. **거는 것은 오타 방지 범위뿐이다**
 * ([D57] A11 — HIIT 상한·하체일로 막지 않는다). 설정 방식에 없는 칸도 거절한다(사이클에 경사).
 * 표에 없는 id(옛 기록)는 옛 칸(시간·거리)만 받는다 — 새 칸은 표가 칸을 정한 운동에만 있다(A3).
 */
export function cardioRangeProblems(exerciseId: string, cardio: CardioFields, opts: { record?: boolean } = {}): string[] {
  const fields = cardioFieldsOf(exerciseId);
  const problems: string[] = [];
  // 기록(§2.4)은 분·초다([D77]) — 분 하한 0 · 초 0–59 정수 · 분+초 > 0. 계획 목표(`cardio` op)는 분 단위 1분 하한 그대로고 초 칸이 없다.
  const record = opts.record === true;
  const has = (value: unknown) => value !== undefined && value !== null;
  // `integer` — 스키마가 정수인 칸(총 시간·레벨). 반올림해 넣으면 300.4분이 300 으로 범위를 비켜 간다(codex 041 N3).
  const check = (label: string, value: unknown, range: Range | undefined, allowed: boolean, integer = false) => {
    if (!has(value)) return;
    if (!allowed) {
      problems.push(`${label} 칸이 없는 운동입니다.`);
      return;
    }
    if (range && (typeof value !== "number" || value < range[0] || value > range[1])) {
      problems.push(`${label}은(는) ${range[0]}–${range[1]} 사이여야 합니다.`);
    } else if (integer && !Number.isInteger(value)) {
      problems.push(`${label}은(는) 정수여야 합니다.`);
    }
  };
  check("총 시간(분)", cardio.duration_min, record ? CARDIO_LIMITS.recordDurationMin : CARDIO_LIMITS.durationMin, true, true);
  check("총 시간(초)", cardio.duration_sec, CARDIO_LIMITS.durationSec, record, true);
  if (record && (cardio.duration_min ?? 0) + (cardio.duration_sec ?? 0) === 0) {
    problems.push("총 시간은 0분 0초일 수 없습니다.");
  }
  check("거리(m)", cardio.distance_m, CARDIO_LIMITS.distanceM, fields.distance);
  check("경사(%)", cardio.incline_pct, fields.incline, Boolean(fields.incline));
  check("레벨", cardio.level, CARDIO_LIMITS.level, fields.level, true);

  const segments = cardio.segments;
  if (segments !== undefined && !fields.segments) {
    problems.push("구간 칸이 없는 운동입니다.");
  } else if (segments !== undefined) {
    const [min, max] = CARDIO_LIMITS.segments;
    if (segments.length < min || segments.length > max) problems.push(`구간은 ${min}–${max}개여야 합니다.`);
    segments.forEach((segment, i) => {
      const at = `구간 ${i + 1}`;
      check(`${at} 시간(초)`, segment.sec, CARDIO_LIMITS.segmentSec, true, true);
      check(`${at} 속도(km/h)`, segment.speed_kmh, fields.speed, Boolean(fields.speed));
      check(`${at} 경사(%)`, segment.incline_pct, fields.incline, Boolean(fields.incline));
      check(`${at} 레벨`, segment.level, CARDIO_LIMITS.level, fields.level, true);
    });
  }
  return problems;
}

/**
 * Bodyweight-only generation cannot assume cardio equipment, even when an old
 * profile still lists machines or cycling. Use outdoor walking/running instead.
 * Otherwise the user's list wins, then the low-interference preference.
 */
/** 추천 이유(코드 enum — 문장은 화면이 만든다). */
export type CardioReason =
  | "low_impact_joint"
  | "bodyweight_circuit"
  | "bodyweight_outdoor"
  | "conditioning_intervals"
  | "fat_loss_low_impact"
  | "hypertrophy_low_interference";

export interface CardioRecommendation {
  /** 1순위 → 대안 순. 주 안의 세션은 이 순서로 돌아가며 받는다. */
  modalities: CardioModality[];
  reason: CardioReason;
  /** 맨몸 서킷 추천(D101 ④ · D102 ②) — 입문 A, 중급 이상 A·B. 서킷 배치는 N7a 가 이 값을 읽는다. */
  circuitFormats: Array<"A" | "B">;
}

/**
 * 유산소 추천(D101 ② — 묻지 않고 코드가 고른다). 규칙표는 백로그 운동목록 06 §5: 위에서부터 첫 일치.
 * 근거는 WHO 2020(중강도 주 150–300분)과 동시 훈련 간섭(달리기 > 자전거 — Wilson 2012). 소음은 보지 않는다(D101 ⑤).
 * **첫 목표가 정한다**(프롬프트 규칙과 같다 — 근비대 → 감량 → 체력 순으로 표에 있다). `cardio_pref`(감량·체력)는
 * 첫 목표가 그 어느 것도 아닐 때(일반 체력·가동성)만 본다 — 근비대 사용자가 체력 유산소를 골랐다고 달리기로 바꾸지 않는다.
 */
export function recommendCardio(profile: UserProfile): CardioRecommendation {
  const bodyweight = profile.environment === "bodyweight_only";
  const goal = profile.goals[0];
  const first =
    goal === "build_muscle" || goal === "gain_strength" || goal === "lose_fat" || goal === "endurance"
      ? goal
      : profile.cardio_pref === "fat_loss"
        ? "lose_fat"
        : profile.cardio_pref === "conditioning"
          ? "endurance"
          : goal;
  if (profile.red_flags?.low_risk?.includes("mild_joint_discomfort")) {
    // 맨몸은 기계가 없다 — 걷기(야외 러닝·워킹 id)와 서서 하는 저충격 서킷(A).
    return bodyweight
      ? { modalities: ["running"], reason: "low_impact_joint", circuitFormats: ["A"] }
      : { modalities: ["cycling", "elliptical", "incline_walk"], reason: "low_impact_joint", circuitFormats: [] };
  }
  if (bodyweight) {
    if (first === "lose_fat") {
      return {
        modalities: ["running"],
        reason: "bodyweight_circuit",
        circuitFormats: profile.experience_level === "beginner" ? ["A"] : ["A", "B"],
      };
    }
    return { modalities: ["running"], reason: "bodyweight_outdoor", circuitFormats: [] };
  }
  if (first === "lose_fat") {
    return { modalities: ["incline_walk", "stairs", "elliptical"], reason: "fat_loss_low_impact", circuitFormats: [] };
  }
  if (first === "endurance") {
    return { modalities: ["running", "rowing", "cycling"], reason: "conditioning_intervals", circuitFormats: [] };
  }
  return { modalities: ["cycling", "incline_walk", "elliptical"], reason: "hypertrophy_low_interference", circuitFormats: [] };
}

/**
 * 주간 용량 키. 유산소 선호가 기본값(`maintain_health`)이면 첫 목표가 정한다 — 체력 → 인터벌 포함(`conditioning`),
 * 감량 → `fat_loss`(06 §5 · D101 ②). `none` 과 사용자가 명시한 선호는 그대로다.
 */
export function cardioDoseKey(profile: UserProfile): UserProfile["cardio_pref"] {
  if (profile.cardio_pref !== "maintain_health") return profile.cardio_pref;
  if (profile.goals[0] === "endurance") return "conditioning";
  if (profile.goals[0] === "lose_fat") return "fat_loss";
  return "maintain_health";
}

/**
 * 세션 하나의 종류. 사용자가 가진 종류(`cardio_modalities` — 동결 Flutter 앱·옛 프로필)가 있으면 그 안에서
 * 추천 순서를 따르고, 없으면(미니앱 — D101 ①) 추천을 `nth` 번째 세션부터 돌려 쓴다.
 */
export function chooseModality(profile: UserProfile, proposed?: string, nth = 0): CardioModality {
  const recommended = recommendCardio(profile).modalities;
  const owned = profile.cardio_modalities.filter((m): m is CardioModality =>
    (ALL_MODALITIES as string[]).includes(m),
  );
  // 맨몸은 기계가 없다 — 옛 기계 선호·드래프트 제안이 남아 있어도 추천(야외)만.
  if (owned.length > 0 && profile.environment !== "bodyweight_only") {
    if (proposed && (owned as string[]).includes(proposed)) return proposed as CardioModality;
    return recommended.find((m) => owned.includes(m)) ?? owned[0]!;
  }
  return recommended[nth % recommended.length]!;
}

/** A day is "heavy lower" when it holds a lower-body compound lift. */
export function isHeavyLowerDay(dayIndex: number, strength: DraftStrengthItem[]): boolean {
  const LOWER = new Set(["quadriceps", "hamstrings", "glutes", "lower back"]);
  return strength.some(
    (item) =>
      item.dayIndex === dayIndex &&
      item.exercise.mechanic === "compound" &&
      item.exercise.primary_muscles.some((muscle) => LOWER.has(muscle)),
  );
}

/**
 * Places the week's cardio.
 *
 * - `cardio_pref: none` → no sessions at all (S-GEN-6 only applies otherwise).
 * - LISS prefers lifting days (after the lifts) and falls back to rest days;
 *   either satisfies research/03, and lifting first is the documented order.
 * - HIIT never lands on a heavy-lower day (S-GEN-6): a non-heavy lifting day
 *   first, then a rest day. If no day qualifies the session is dropped with a
 *   note rather than scheduled somewhere unsafe.
 */
export function planCardio(
  profile: UserProfile,
  strength: DraftStrengthItem[],
  proposedByDay: Map<number, { modality?: string; style?: string }> = new Map(),
): CardioPlan {
  const dose = CARDIO_DOSE[cardioDoseKey(profile)];
  const notes: string[] = [];
  if (dose.lissSessions === 0 && dose.hiitSessions === 0) return { sessions: [], notes };

  // Only real weekdays. An out-of-range dayIndex upstream must not become a
  // cardio session on a day the week does not have.
  const liftDays = [...new Set(strength.map((item) => item.dayIndex))]
    .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
    .sort((a, b) => a - b);
  const heavyLower = new Set(liftDays.filter((day) => isHeavyLowerDay(day, strength)));
  const sessions: CardioSession[] = [];
  const used = new Set<number>();

  const place = (day: number, style: CardioStyle, durationMin: number) => {
    const proposed = proposedByDay.get(day);
    const modality = chooseModality(profile, style === "HIIT" ? undefined : proposed?.modality, sessions.length);
    // S-GEN-6 forbids cardio in the *same session* as heavy lower-body work. On
    // such a day the cardio becomes a separate session — research/03 puts the
    // interference at near zero once the two are ≥3 h apart.
    const placement: CardioPlacement = !liftDays.includes(day)
      ? "rest_day"
      : heavyLower.has(day)
        ? "separate_session"
        : "after_lifting";
    if (placement === "separate_session") {
      notes.push(
        `${day}일은 무거운 하체일이라 유산소를 별도 세션으로 분리했습니다(최소 ${CARDIO_RULES.preferredSeparationHours}시간 간격).`,
      );
    }
    sessions.push({
      dayIndex: day, modality, style, durationMin, intensityZone: ZONE[style], placement,
      // The running modality defaults to a treadmill. Carry the concrete outdoor
      // id through expansion so bodyweight-only cannot turn back into a machine.
      ...(profile.environment === "bodyweight_only" ? { exerciseId: "trail_running_walking" } : {}),
    });
    used.add(day);
  };

  // HIIT first: it has the strictest constraint — never on a heavy-lower day at
  // all, not even as a separate session (research/03: avoid adjacency).
  // 관절 불편이면 인터벌을 자동 배치하지 않는다 — 06 §5 최우선 행(저충격 · RPE 4–6). 사용자 편집은 그대로다.
  const joint = profile.red_flags?.low_risk?.includes("mild_joint_discomfort") ?? false;
  const hiitCount = joint ? 0 : Math.min(dose.hiitSessions, CARDIO_RULES.hiitMaxPerWeek);
  for (let i = 0; i < hiitCount; i += 1) {
    const safeDay = liftDays.find((day) => !used.has(day) && !heavyLower.has(day));
    if (safeDay === undefined) {
      notes.push("HIIT 세션을 배치할 안전한 날이 없어 제외했습니다(무거운 하체일 회피 — S-GEN-6).");
      continue;
    }
    place(safeDay, "HIIT", dose.hiitMin);
  }

  // LISS: **lifting days only** — `days_per_week` 는 활동일 총수다([D45] ①). 휴식일로 넘기면 주 2회가
  // 「근력 2일 + 유산소만 1일」= 3일이 된다(백로그 078). 모자라면 줄인다(하루 1회). 휴식일 유산소는 사용자
  // 편집(`cardio_override` → `applyCardioOverrides`)으로만 생긴다. 무거운 하체일은 별도 세션으로 받는다.
  const lightLiftDays = liftDays.filter((day) => !heavyLower.has(day));
  const heavyLiftDays = liftDays.filter((day) => heavyLower.has(day));
  const lissDays = [...lightLiftDays, ...heavyLiftDays].filter((day) => !used.has(day));
  for (let i = 0; i < dose.lissSessions; i += 1) {
    const day = lissDays[i];
    if (day === undefined) {
      notes.push("주간 일정에 여유가 없어 LISS 세션 일부를 배치하지 못했습니다.");
      break;
    }
    place(day, "LISS", dose.lissMin);
  }

  return { sessions: sessions.sort((a, b) => a.dayIndex - b.dayIndex), notes };
}

/** 사용자가 정한 유산소 목표([D57] A1·A9 · 041 G0 Q1) — 방식·총 시간은 필수, 나머지는 운동별 칸. */
export interface CardioTarget extends CardioTargetExtra {
  style: CardioStyle;
  duration_min: number;
}

/**
 * 사용자가 그 요일 유산소에 내린 결정(백로그 030 §1.1 · [D45] ④ · [D57]). 드래프트 요일의 `cardio_override`.
 * `{exercise_id, target?}` — 고른 운동(13종)과 목표. 옛 모양 `{modality}` 는 그 분류의 기본 id 로 읽는다.
 */
export type CardioOverride = { exercise_id: string; target?: CardioTarget } | "none";

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** 목표의 모양만 추린다(범위는 `cardioRangeProblems`). 모르는 키와 숫자가 아닌 칸은 버린다. */
export function parseCardioTarget(value: unknown): CardioTarget | undefined {
  const v = value as Record<string, unknown> | null;
  if (!v || typeof v !== "object" || (v.style !== "LISS" && v.style !== "HIIT") || !finite(v.duration_min)) return undefined;
  const target: CardioTarget = { style: v.style, duration_min: v.duration_min };
  if (finite(v.distance_m)) target.distance_m = v.distance_m;
  if (finite(v.incline_pct)) target.incline_pct = v.incline_pct;
  if (finite(v.level)) target.level = v.level;
  if (Array.isArray(v.segments)) {
    target.segments = v.segments.flatMap((raw) => {
      const s = raw as Record<string, unknown> | null;
      if (!s || typeof s !== "object" || !finite(s.sec)) return [];
      const seg: CardioSegment = { sec: s.sec };
      if (typeof s.label === "string" && s.label) seg.label = s.label;
      if (finite(s.speed_kmh)) seg.speed_kmh = s.speed_kmh;
      if (finite(s.incline_pct)) seg.incline_pct = s.incline_pct;
      if (finite(s.level)) seg.level = s.level;
      return [seg];
    });
  }
  return target;
}

/**
 * 직전 주 기록에서 그 운동의 **가장 최근 날짜** 기록을 목표로 되돌린다([D57] A10 · 041 N6).
 * 없으면 `undefined` — 그 자리는 도스표가 정한 분·방식이 그대로 남는다.
 *
 * **강등·절삭하지 않는다**(A11). 무거운 하체일의 인터벌도, 그 주 세 번째 HIIT 도 그대로 온다 —
 * 배치 표시(`placement`)만 코드가 정한다. 사용자가 한 것을 기본으로 되돌리지 않는 것이 A11 이다.
 *
 * 옛 기록(`style` 없음)은 `LISS` 로 읽는다 — 방식 칸이 생기기 전의 유산소는 기본이었다.
 */
export function cardioTargetFromPriorLogs(exerciseId: string, priorLogs: unknown[]): CardioTarget | undefined {
  let best: { key: string; cardio: Record<string, unknown> } | undefined;
  [...(priorLogs ?? [])].forEach((raw, i) => {
    const session = raw as { date?: unknown; day_index?: unknown; exercises?: unknown } | null;
    if (!session || typeof session !== "object" || !Array.isArray(session.exercises)) return;
    // 같은 주에 두 번 했으면 **늦은 쪽**이 목표다(T6-2). 날짜 → 요일 → 배열 순서로 줄 세운다 —
    // 옛 문서에 `date` 가 없을 수 있어 요일이 받치고, 그것도 없으면 나중에 실린 것이 나중이다.
    const key = [
      typeof session.date === "string" ? session.date : "",
      String(finite(session.day_index) ? session.day_index : -1).padStart(3, "0"),
      String(i).padStart(4, "0"),
    ].join("|");
    for (const rawEx of session.exercises as Array<{ exercise_id?: unknown; sets?: unknown }>) {
      // **같은 운동만**(A10) — 분류로 맞추면 스테어마스터 기록이 스텝밀 목표가 된다(T6-5).
      if (rawEx?.exercise_id !== exerciseId || !Array.isArray(rawEx.sets)) continue;
      for (const rawSet of rawEx.sets as Array<Record<string, unknown>>) {
        const cardio = rawSet?.cardio;
        if (!cardio || typeof cardio !== "object") continue;
        if (!best || key > best.key) best = { key, cardio: cardio as Record<string, unknown> };
      }
    }
  });
  if (!best) return undefined;
  const c = best.cardio;
  // 기록은 분·초라 0분 N초일 수 있다([D77]) — 목표는 분 단위 1분 하한이라 올려 잡는다. 초는 목표에 없다.
  const minutes = finite(c.duration_min) ? Math.max(1, c.duration_min) : c.duration_min;
  return parseCardioTarget({ ...c, duration_min: minutes, duration_sec: undefined, style: c.style === "LISS" || c.style === "HIIT" ? c.style : "LISS" });
}

export function parseCardioOverride(value: unknown): CardioOverride | undefined {
  if (value === "none") return "none";
  const v = value as { exercise_id?: unknown; modality?: unknown; target?: unknown } | null;
  if (typeof v?.exercise_id === "string" && CARDIO_EXERCISES[v.exercise_id]) {
    const target = parseCardioTarget(v.target);
    return target ? { exercise_id: v.exercise_id, target } : { exercise_id: v.exercise_id };
  }
  const modality = v?.modality;
  return typeof modality === "string" && (ALL_MODALITIES as string[]).includes(modality)
    ? { exercise_id: CARDIO_EXERCISE_IDS[modality as CardioModality] }
    : undefined;
}

/**
 * 다른 유산소로 바꿀 때 목표 중 **새 운동의 설정 방식에 있는 칸만** 남긴다([D57] A14). 방식·총 시간은 모든
 * 유산소에 있어 늘 남는다(러닝→걷기면 거리도 남고, 러닝→사이클이면 거리는 버린다). 구간도 같은 규칙.
 *
 * **칸이 같아도 범위가 다르면 버린다**(codex 041 N4 R2). 마이마운틴 경사는 −5~50, 트레드밀은 −3~20 이라
 * 경사 30 을 그대로 옮기면 새 운동에서는 범위 밖 목표가 된다. 교체는 사용자가 목표를 다시 보낸 게
 * 아니므로 `400` 으로 막지 않고(A11 은 범위 말고는 막지 않는다) 그 칸만 떨어뜨린다.
 */
export function keepForForm(target: CardioTarget, exerciseId: string): CardioTarget {
  const fields = cardioFieldsOf(exerciseId);
  const out: CardioTarget = { style: target.style, duration_min: target.duration_min };
  if (fields.distance && target.distance_m !== undefined) out.distance_m = target.distance_m;
  if (fields.incline && target.incline_pct !== undefined) out.incline_pct = target.incline_pct;
  if (fields.level && target.level !== undefined) out.level = target.level;
  if (fields.segments && target.segments) {
    out.segments = target.segments.map((s) => {
      const seg: CardioSegment = { sec: s.sec };
      if (s.label) seg.label = s.label;
      if (fields.speed && s.speed_kmh !== undefined) seg.speed_kmh = s.speed_kmh;
      if (fields.incline && s.incline_pct !== undefined) seg.incline_pct = s.incline_pct;
      if (fields.level && s.level !== undefined) seg.level = s.level;
      return seg;
    });
  }
  // 범위 밖 칸은 **그 칸만** 버린다 — 구간도 같은 규칙이라 배열을 통째로 지우지 않는다(codex 041 N4 R4).
  const outside = (value: number | undefined, range: Range | undefined) =>
    value !== undefined && range !== undefined && (value < range[0] || value > range[1]);
  if (outside(out.distance_m ?? undefined, CARDIO_LIMITS.distanceM)) delete out.distance_m;
  if (outside(out.incline_pct ?? undefined, fields.incline)) delete out.incline_pct;
  if (outside(out.level ?? undefined, CARDIO_LIMITS.level)) delete out.level;
  if (out.segments) {
    out.segments = out.segments.map((seg) => {
      const kept: CardioSegment = { ...seg };
      if (outside(kept.speed_kmh, fields.speed)) delete kept.speed_kmh;
      if (outside(kept.incline_pct, fields.incline)) delete kept.incline_pct;
      if (outside(kept.level, CARDIO_LIMITS.level)) delete kept.level;
      return kept;
    });
  }
  return out;
}

/** 목표를 세션에 덮는다. 강도존은 방식을 따라 코드가 정하고, 배치(S-GEN-6 표시)는 건드리지 않는다([D57] A11). */
/** 목표를 세션에 얹는다. 지난 기록 복사(041 N6)와 사용자 결정이 **같은 규칙**을 타야 값이 갈리지 않는다. */
export function applyCardioTarget(session: CardioSession, target: CardioTarget): void {
  const { style, duration_min, ...extra } = target;
  session.style = style;
  session.durationMin = duration_min;
  session.intensityZone = ZONE[style];
  session.extra = extra;
}

/**
 * `planCardio` 결과에 사용자 결정을 덮는다. 목표가 없으면 **운동과 유무만** 바뀌고 분·존은 도스표가 정한다.
 * 목표가 있으면 방식·분·칸을 사용자 값으로 덮는다([D57] — **범위 말고는 막지 않는다**: HIIT 주 상한·하체일
 * 규칙을 타지 않고 배치 표시만 그대로다, A11).
 *
 * - `"none"` → 그 날 세션만 뺀다. 뺀 회수를 다른 날로 옮기지 않는다 — 사용자가 뺀 건
 *   「그 날의 유산소」다.
 * - `{exercise_id, target?}` → 있는 세션은 운동을 바꾼다(분류는 표에서). **`chooseModality` 필터를 타지
 *   않는다**(러닝 포함) — 사용자가 직접 골랐다. 없는 날이면 LISS 1회를 도스 분으로 놓는다. 목표가 있으면 덮는다.
 */
export function applyCardioOverrides(
  sessions: CardioSession[],
  overrides: Map<number, CardioOverride>,
  profile: UserProfile,
  strength: DraftStrengthItem[],
): CardioSession[] {
  const out = sessions.filter((s) => overrides.get(s.dayIndex) !== "none");
  for (const [day, override] of overrides) {
    if (override === "none") continue;
    const modality = CARDIO_EXERCISES[override.exercise_id]?.modality ?? "cycling";
    let session = out.find((s) => s.dayIndex === day);
    if (session) {
      session.modality = modality;
    } else {
      // `cardio_pref: none` 는 도스 분이 0 이다 — D45 ③ 이 정한 기본값(maintain_health)의 분을 쓴다.
      const durationMin = CARDIO_DOSE[cardioDoseKey(profile)].lissMin || CARDIO_DOSE.maintain_health.lissMin;
      const lifts = strength.some((item) => item.dayIndex === day);
      const placement: CardioPlacement = !lifts ? "rest_day" : isHeavyLowerDay(day, strength) ? "separate_session" : "after_lifting";
      session = { dayIndex: day, modality, style: "LISS", durationMin, intensityZone: ZONE.LISS, placement };
      out.push(session);
    }
    session.exerciseId = override.exercise_id;
    if (override.target) applyCardioTarget(session, override.target);
  }
  return out.sort((a, b) => a.dayIndex - b.dayIndex);
}
