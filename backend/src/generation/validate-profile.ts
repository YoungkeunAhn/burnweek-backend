/**
 * 프로필 신뢰 경계. `parseRequest` 가 body 의 `profile` 을 그대로 통과시키고
 * 있었다 — 클라이언트가 상수를 보내던 동안에는 안전했지만, 온보딩이 붙어
 * 사용자 입력이 들어오는 순간 **미검증 값이 그대로 LLM 프롬프트로 간다.**
 *
 * 클라이언트 검증은 우회된다(HTTP 를 직접 부르면 그만이다). 여기가 정본이다.
 *
 * 값의 출처는 계약 하나다 — `docs/specs/features/004-onboarding/contracts/questionnaire.md`
 * 와 `types.ts` 의 `UserProfile`. enum 이 늘면 두 곳을 같이 고친다.
 */
import { SPLIT_PREFS } from "../data/splits";
import type { Goal, UserProfile } from "./types";

const GOALS = ["build_muscle", "gain_strength", "lose_fat", "endurance", "mobility", "general_fitness"] as const;
/** 다중 선택 상한. 넘으면 목표가 서로 상쇄돼 아무 특성 없는 플랜이 된다. */
const MAX_GOALS = 3;
const LEVELS = ["beginner", "novice_intermediate"] as const;
const ENVIRONMENTS = ["full_gym", "home_gym", "minimal", "bodyweight_only"] as const;
const CARDIO_PREFS = ["none", "maintain_health", "fat_loss", "conditioning"] as const;
const SESSION_LENGTHS = [30, 45, 60, 75, 90] as const;
const HARD_FLAGS = [
  "pregnancy",
  "cardiac_condition",
  "recent_surgery",
  "acute_injury",
  "chest_pain_on_exertion",
] as const;
const LOW_RISK_FLAGS = ["mild_joint_discomfort", "managed_hypertension", "general_soreness"] as const;
// D55 ④ — 선택. 없으면 키 자체를 싣지 않는다(undefined 는 Firestore 가 거부한다).
// 성별은 받지 않는다(2026-09-15 — 기기에만). 보내도 허용목록 밖이라 조용히 버려진다.
const FOCUS_AREAS = ["lower", "upper", "balanced"] as const;

const oneOf = <T extends readonly unknown[]>(list: T, v: unknown): v is T[number] => list.includes(v as never);

/** 문자열 배열이고 모든 원소가 허용목록 안. `undefined` 는 빈 배열로 본다. */
function stringList(v: unknown, allowed?: readonly string[]): string[] | null {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return null;
  if (!v.every((x) => typeof x === "string")) return null;
  if (allowed && !v.every((x) => allowed.includes(x))) return null;
  return v as string[];
}

/**
 * 유효하면 **정규화된** 프로필을, 아니면 이유를 돌려준다.
 *
 * 정규화까지 하는 이유: 선택 필드가 빠진 채로 와도 001 생성은 전 필드를 전제한다
 * (계약 "기본값" 절). 여기서 채우지 않으면 확장 엔진이 `undefined` 를 만난다.
 */
export function validateProfile(input: unknown): { profile: UserProfile } | { error: string } {
  const p = input as Record<string, unknown> | null | undefined;
  if (!p || typeof p !== "object" || Array.isArray(p)) return { error: "profile 이 객체가 아닙니다." };

  // 다중 목표. 동결된 Flutter 앱(D16)은 단수 `goal` 을 보내므로 그것도 받는다 —
  // 두 클라이언트가 같은 백엔드를 쓰는 한 여기가 유일한 호환 지점이다.
  const goalsRaw = p.goals ?? (p.goal === undefined ? undefined : [p.goal]);
  if (!Array.isArray(goalsRaw) || goalsRaw.length === 0) {
    return { error: "goals 는 1개 이상의 배열이어야 합니다." };
  }
  if (goalsRaw.length > MAX_GOALS) return { error: `goals 는 최대 ${MAX_GOALS}개까지 고를 수 있습니다.` };
  if (!goalsRaw.every((g) => oneOf(GOALS, g))) return { error: "goals 값이 올바르지 않습니다." };
  // 중복은 거부하지 않고 접는다 — 같은 값을 두 번 보내는 건 클라이언트 버그지
  // 사용자 잘못이 아니고, 접고 나면 의미가 정확히 같다.
  const goals = [...new Set(goalsRaw as Goal[])];
  if (!oneOf(LEVELS, p.experience_level)) return { error: "experience_level 값이 올바르지 않습니다." };
  if (!oneOf(ENVIRONMENTS, p.environment)) return { error: "environment 값이 올바르지 않습니다." };

  // 분할은 **선택 필드**다 — 안 보내면 일수로 자동 선택된다(D24). 값이 있으면
  // 허용목록 안이어야 한다: 여기가 프롬프트로 가는 값의 유일한 관문이다.
  const splitPref = p.split_pref;
  if (splitPref !== undefined && !oneOf(SPLIT_PREFS, splitPref)) {
    return { error: "split_pref 값이 올바르지 않습니다." };
  }

  const days = p.days_per_week;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 2 || days > 6) {
    return { error: "days_per_week 는 2–6 의 정수여야 합니다." };
  }

  // 선택 필드는 미입력 시 계약의 기본값으로 채운다.
  const sessionLen = p.session_len_min ?? 45;
  if (!oneOf(SESSION_LENGTHS, sessionLen)) return { error: "session_len_min 값이 올바르지 않습니다." };

  const cardioPref = p.cardio_pref ?? "maintain_health";
  if (!oneOf(CARDIO_PREFS, cardioPref)) return { error: "cardio_pref 값이 올바르지 않습니다." };

  // 장비·유산소 모달리티는 카탈로그 데이터라 enum 을 여기 복제하지 않는다 —
  // 모르는 값은 후보 필터에서 아무것도 매치하지 않고 조용히 무시된다.
  const equipment = stringList(p.equipment);
  if (!equipment) return { error: "equipment 는 문자열 배열이어야 합니다." };
  const cardioModalities = stringList(p.cardio_modalities);
  if (!cardioModalities) return { error: "cardio_modalities 는 문자열 배열이어야 합니다." };

  const injuriesRaw = p.injuries ?? [];
  if (!Array.isArray(injuriesRaw)) return { error: "injuries 는 배열이어야 합니다." };
  const injuries: UserProfile["injuries"] = [];
  for (const it of injuriesRaw) {
    const i = it as Record<string, unknown> | null;
    if (!i || typeof i !== "object" || typeof i.region !== "string") {
      return { error: "injuries 원소는 {region} 를 가져야 합니다." };
    }
    injuries.push(typeof i.note === "string" ? { region: i.region, note: i.note } : { region: i.region });
  }

  // 레드플래그는 미니앱에서 D18 로 파기됐지만 Flutter 앱(동결)이 계속 보낸다.
  // 값을 받되 허용목록 밖은 거부한다 — 여기가 생성 차단 게이트의 입력이다.
  const rf = (p.red_flags ?? {}) as Record<string, unknown>;
  if (typeof rf !== "object" || Array.isArray(rf)) return { error: "red_flags 는 객체여야 합니다." };
  const hard = stringList(rf.hard, HARD_FLAGS);
  const lowRisk = stringList(rf.low_risk, LOW_RISK_FLAGS);
  if (!hard || !lowRisk) return { error: "red_flags 값이 올바르지 않습니다." };

  // 가능요일(D46)은 **선택 필드**다 — 없으면 키도 만들지 않는다(Firestore 는 undefined 를
  // 거부한다). 있으면 요일 정수 배열이고, 주당 일수보다 적으면 거절한다: 통과시키면
  // 코드가 요일을 채우지 못해 개수 검사가 매 시도 실패하고 재시도 예산을 다 태운다.
  const focusArea = p.focus_area;
  if (focusArea !== undefined && !oneOf(FOCUS_AREAS, focusArea)) return { error: "focus_area 값이 올바르지 않습니다." };

  const daysRaw = p.available_days;
  let availableDays: number[] | undefined;
  if (daysRaw !== undefined) {
    if (!Array.isArray(daysRaw) || !daysRaw.every((d) => typeof d === "number" && Number.isInteger(d) && d >= 0 && d <= 6)) {
      return { error: "available_days 는 0–6 정수 배열이어야 합니다." };
    }
    // 중복은 goals 처럼 접는다 — 클라이언트 버그지 사용자 잘못이 아니다.
    availableDays = [...new Set(daysRaw as number[])].sort((a, b) => a - b);
    if (availableDays.length < days) {
      return { error: `available_days 는 days_per_week(${days})개 이상이어야 합니다.` };
    }
  }

  return {
    profile: {
      goals,
      ...(splitPref === undefined ? {} : { split_pref: splitPref }),
      experience_level: p.experience_level,
      days_per_week: days,
      ...(availableDays === undefined ? {} : { available_days: availableDays }),
      ...(focusArea === undefined ? {} : { focus_area: focusArea }),
      session_len_min: sessionLen,
      environment: p.environment,
      equipment,
      cardio_pref: cardioPref,
      cardio_modalities: cardioModalities,
      injuries,
      red_flags: { hard: hard as UserProfile["red_flags"]["hard"], low_risk: lowRisk as UserProfile["red_flags"]["low_risk"] },
    },
  };
}
