/**
 * 분할(split) 템플릿 — **큰 근육이 분할 축이고, 작은 근육은 거기에 붙는다**(D24).
 *
 * 가슴·등·하체가 축이고 어깨는 분할 수가 늘면 떼어 승격한다. 삼두는 가슴에,
 * 이두·전완은 등에 붙는다(협응근이 같은 날 끝나 회복일이 겹치지 않는다).
 * 복근은 어느 날에든 들어갈 수 있지만 **주에 한 날에만** 넣는다.
 *
 * 근육 이름은 카탈로그의 17-값 taxonomy 그대로다(`exercises.json` 의
 * `primary_muscles`) — 여기서 이름을 새로 만들면 매칭이 조용히 실패한다.
 *
 * `full_body`·`push_pull_legs` 에는 템플릿이 없다. 그 둘은 사용자가 고르는 값이
 * 아니라 **비-헬스장 경로에서 일수로 자동 선택**되는 값이고, 거기에 부위 규칙을
 * 새로 씌우면 지금 잘 돌던 생성이 규칙 위반으로 실패하기 시작한다(D24 §범위).
 */

export type SplitType =
  | "full_body"
  | "upper_lower"
  | "push_pull_legs"
  | "body_part_3"
  | "body_part_4"
  | "body_part_5";

/** 온보딩이 고를 수 있는 값 = 2~5분할. 나머지 둘은 자동 선택 전용이다. */
export type SplitPref = "upper_lower" | "body_part_3" | "body_part_4" | "body_part_5";

export const SPLIT_PREFS: SplitPref[] = ["upper_lower", "body_part_3", "body_part_4", "body_part_5"];

/** 그 분할을 돌리는 데 필요한 최소 훈련일 수. 모자라면 `chooseSplit` 이 강등한다. */
export const MIN_DAYS_FOR: Record<SplitPref, number> = {
  upper_lower: 2,
  body_part_3: 3,
  body_part_4: 4,
  body_part_5: 5,
};

export const SPLIT_LABEL_KO: Record<SplitType, string> = {
  full_body: "전신",
  upper_lower: "2분할 · 상하체",
  push_pull_legs: "PPL",
  body_part_3: "3분할 · 부위별",
  body_part_4: "4분할 · 부위별",
  body_part_5: "5분할 · 부위별",
};

const LEGS = ["quadriceps", "hamstrings", "glutes", "calves", "abductors", "adductors"];
const BACK = ["lats", "middle back", "lower back", "traps"];
/** 당기기 협응근 — 등에 붙는다. */
const PULL_ARMS = ["biceps", "forearms"];

/**
 * 어느 날에든 허용되는 근육. 복근은 분할 축이 아니라 어디에나 끼워 넣는 부위고,
 * 목은 8종밖에 없어 축을 만들 가치가 없다. 복근에는 **하루 제한**이 따로 붙는다.
 */
export const FLEX_MUSCLES = ["abdominals", "neck"];

export interface SplitDay {
  /** 프롬프트·경고에 그대로 쓰는 한국어 이름. */
  label: string;
  /** 그 날 허용되는 주근육(17-값). `FLEX_MUSCLES` 는 여기 없어도 항상 허용된다. */
  muscles: string[];
}

/** 훈련일 순서 → 부위. n번째 훈련일은 `template[n % template.length]` 이다. */
const TEMPLATES: Partial<Record<SplitType, SplitDay[]>> = {
  upper_lower: [
    { label: "상체", muscles: ["chest", ...BACK, "shoulders", "biceps", "triceps", "forearms"] },
    { label: "하체", muscles: LEGS },
  ],
  body_part_3: [
    { label: "가슴·삼두", muscles: ["chest", "triceps"] },
    { label: "등·이두", muscles: [...BACK, ...PULL_ARMS] },
    { label: "하체·어깨", muscles: [...LEGS, "shoulders"] },
  ],
  body_part_4: [
    { label: "가슴·삼두", muscles: ["chest", "triceps"] },
    { label: "등·이두", muscles: [...BACK, ...PULL_ARMS] },
    { label: "어깨", muscles: ["shoulders"] },
    { label: "하체", muscles: LEGS },
  ],
  body_part_5: [
    { label: "가슴", muscles: ["chest"] },
    { label: "등", muscles: BACK },
    { label: "하체", muscles: LEGS },
    { label: "어깨", muscles: ["shoulders"] },
    { label: "팔", muscles: ["biceps", "triceps", "forearms"] },
  ],
};

/** 그 분할의 훈련일 템플릿, 또는 부위 규칙이 없는 분할이면 `null`. */
export function splitTemplate(split: SplitType): SplitDay[] | null {
  return TEMPLATES[split] ?? null;
}

/**
 * 프로필 → 분할.
 *
 * 사용자가 고른 값이 이기되, **훈련일 수보다 잘게 쪼갠 분할은 강등한다** — 주 3일에
 * 5분할이면 두 부위가 아예 편성되지 않아 사용자가 고른 의미가 사라진다. 강등 사실은
 * 호출 층이 `pref !== 결과` 로 알아채 경고로 남긴다.
 *
 * 고르지 않았으면(비-헬스장 경로·동결 Flutter 앱) 종전대로 일수로만 정한다.
 *
 * 일수 도메인은 2–6 이다(UserProfile / WeeklyPlan v1) — 이번 주에 하루만 남은 생성의 1 만 더 받는다([D80]). 그 밖은 호출자 버그라
 * 조용히 분할에 매핑하지 않고 던진다.
 */
export function chooseSplit(daysPerWeek: number, pref?: SplitPref): SplitType {
  if (!Number.isInteger(daysPerWeek) || daysPerWeek < 1 || daysPerWeek > 6) {
    throw new RangeError(`days_per_week must be an integer 1–6, got ${daysPerWeek}`);
  }
  // 1회는 이번 주에 하루만 남은 생성뿐이다([D80] ③ · `weekProfile`) — 설정 도메인(2–6)은 그대로다.
  if (daysPerWeek === 1) return "full_body";
  // 모르는 값은 **안 고른 것으로 본다** — 검증기가 이미 거르지만, 여기까지 온
  // 쓰레기 값을 "감당 못 하는 분할"로 읽으면 조용히 강등돼 일수 규칙이 뒤집힌다.
  const minDays = pref === undefined ? undefined : MIN_DAYS_FOR[pref];
  if (pref !== undefined && minDays !== undefined) {
    if (minDays <= daysPerWeek) return pref;
    // 강등 — 일수로 감당되는 가장 잘게 쪼갠 분할. 사용자 의도(더 쪼개고 싶다)에 가장 가깝다.
    return [...SPLIT_PREFS].reverse().find((p) => MIN_DAYS_FOR[p] <= daysPerWeek) ?? "upper_lower";
  }
  if (daysPerWeek <= 3) return "full_body";
  if (daysPerWeek === 4) return "upper_lower";
  return "push_pull_legs";
}
