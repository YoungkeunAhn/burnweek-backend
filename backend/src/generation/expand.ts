/**
 * Code expansion engine — DraftPlan (numeric-light) → WeeklyPlan v1 (final).
 * THIS is where INV-1 lives: all numbers (sets, load, rest, %1RM, cardio
 * duration/zone) and all safety limits are computed by CODE, never the LLM.
 *
 * Built up node by node (docs/guides/execution-graph.md):
 *   B2 (here)      split selection + set allocation
 *   B3 loading.ts  load / e1RM / double progression
 *   B4 cardio.ts + contraindications.ts
 *   B5             assembles WeeklyPlan v1 + final validation + fallbacks
 *   B6             wires it into the handler and runs E2E
 * B5 is in: `expandDraftToWeeklyPlan` returns a real WeeklyPlan v1 plus warnings
 * and rule problems. B6 wires it into the request handler.
 */
import {
  BEGINNER_LOAD_INCREMENT_KG,
  BEGINNER_START_LOAD_KG,
  BODYWEIGHT_LADDERS,
  CAP_GROUPS,
  HAND_LOAD,
  LOAD_INCREMENT_KG,
  MEV_ANCHORS,
  WEEKLY_VOLUME_CAPS,
  WARMUP_SETS,
  type CapGroup,
} from "../data/constants";
import {
  allowedByTools,
  allowedEquipment,
  byId,
  equipmentFor,
  capGroupsOf,
  contraindicationTags,
  ownedTools,
  resolve,
  type Exercise,
} from "../data/exercises";
import { FLEX_MUSCLES, SPLIT_LABEL_KO, chooseSplit, splitTemplate, type SplitDay, type SplitType } from "../data/splits";
import {
  applyCardioOverrides,
  applyCardioTarget,
  cardioTargetFromPriorLogs,
  cardioExerciseId,
  parseCardioOverride,
  planCardio,
  recommendCardio,
  toCardioDetail,
  type CardioDetail,
  type CardioOverride,
} from "./cardio";
import { contraindicatedMuscles, excludeContraindicated } from "./contraindications";
import { CIRCUIT_TEMPLATES, circuitMinutes, circuitTemplateFor, expandCircuit, type CircuitTemplate } from "../data/circuits";
import {
  allowsLoadIncrease,
  nextBodyweightStep,
  prescribeLoad,
  priorSetsFor,
  repRangeFor,
  type ProgressionDecision,
} from "./loading";
import { checkPlanRules } from "./plan-rules";
import { hasHistoryGap } from "./prior-history";
import type { CompletedDay, FocusArea, UserProfile } from "./types";

export interface ExpandInput {
  draft: unknown; // validated DraftPlan
  profile: UserProfile;
  userId: string;
  weekStartDate: string;
  weekNumber: number;
  priorLogs: unknown[];
  disclaimer: string;
  /**
   * 누가 만든 주인가(D54 ①) — 생성은 `ai`, 빈 주는 `manual`, 편집은 저장된 값을 그대로.
   * **없으면 `plan_meta.source` 키도 없다** — 옛 문서를 AI 로 부르지 않는다(039 §1).
   */
  source?: "ai" | "manual";
  /** 이번 주 완료 세션(D60 ②) — 생성만 싣는다. 편집 재확장은 비워 종전대로 첫 훈련일부터 센다. */
  completedThisWeek?: CompletedDay[];
  /** AI generation only: exact ids shown in `<available_exercise_ids>`. */
  allowedGeneratedExerciseIds?: readonly string[];
  /**
   * `plan_meta.days_per_week` 에 쓸 값 — 생성은 사용자 설정값을 넘긴다([D80] ③). 이번 주 회수가 남은 날만큼
   * 줄어도(`weekProfile`) 설정은 그대로라, 없으면 `profile.days_per_week` 다.
   */
  planDaysPerWeek?: number;
  /**
   * 맨몸 서킷 생성(D101 ④ · D102) — 켜면 서킷 추천을 받은 사용자(`recommendCardio().circuitFormats`)의 유산소 세션을
   * 서킷 묶음으로 바꾼다. 화면(N7b)이 서킷을 그리기 전까지 꺼 둔다(실행 그래프 N7a↔N7b 짝 · T7-5).
   */
  circuits?: boolean;
}

export { chooseSplit, type SplitType } from "../data/splits";

/** Beginner set-count bounds per exercise. Schema allows 1–10; we stay narrower. */
const SETS_PER_EXERCISE = { min: 2, max: 4 } as const;

// ── Draft item resolution ────────────────────────────────────────────────────

/** One strength item of the draft, bound to a real catalogue exercise. */
export interface DraftStrengthItem {
  dayIndex: number;
  order: number;
  exercise: Exercise;
  role: "primary" | "secondary" | "accessory";
  repIntent: "strength" | "hypertrophy" | "endurance";
  /** The id the LLM asked for — kept for diagnostics when it was rewritten. */
  requestedId: string;
  /**
   * 사용자가 직접 정한 값(백로그 016 §5 선택지 3). 드래프트에 남아 있어 재확장해도
   * 살아남는다. **코드 계산을 지우는 게 아니라 마지막에 덮어쓴다** — 볼륨 상한·금기는
   * 그대로 걸리고, 상한을 넘기면 `checkPlanRules` 가 422 로 거절한다(INV-1).
   */
  setsOverride?: number;
  loadOverride?: number;
  /**
   * 사용자가 직접 넣거나 바꾼 종목(백로그 016 · [D20-1]). **볼륨 예산이 넘쳐도
   * 버리지 않는다** — 경고를 없애기로 한 이상(D20-1) 조용히 사라지면 거짓말이 된다.
   * LLM 이 넣은 항목에는 붙지 않으므로 생성 경로의 동작은 그대로다.
   */
  userPick?: boolean;
}

export interface ResolvedDraft {
  splitType: SplitType;
  /** Split the LLM proposed, when it disagreed with `splitType`. */
  overriddenSplit?: string;
  strength: DraftStrengthItem[];
  /** Draft ids the catalogue does not know — the pipeline decides what to do. */
  unresolvedIds: string[];
  /**
   * Draft-level rule violations (02-data-model §B2 "코드가 소유하는 추가 검증").
   * The JSON schema cannot express these, and a draft that breaks them is the
   * LLM's mistake — the pipeline feeds them back into its repair retry rather
   * than expanding a malformed week.
   */
  problems: string[];
}

const LIFT_SESSIONS = ["lift", "lift_plus_cardio"];

interface RawDraftItem {
  kind?: unknown;
  exercise_id?: unknown;
  role?: unknown;
  order?: unknown;
  rep_intent?: unknown;
  sets_override?: unknown;
  load_kg_override?: unknown;
  user_pick?: unknown;
  /** P1 이유·대체 운동(02-data-model §B1a) — 그 종목에 대한 값이다. */
  reason?: unknown;
  alternatives?: unknown;
}

interface RawDraftDay {
  day_index?: unknown;
  session_type?: unknown;
  items?: unknown;
  cardio_override?: unknown;
  /** 그 요일에 고른 서킷 템플릿 id(N7a) — 확장이 남기고 재확장이 읽는다. */
  circuit_template?: unknown;
}

const ROLES = ["primary", "secondary", "accessory"] as const;
const REP_INTENTS = ["strength", "hypertrophy", "endurance"] as const;

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/**
 * 드래프트 항목의 렙 의도. 입문자에게는 저렙 근력 렙을 주지 않는다(D104 ②) — LLM 이 strength 를 골라도
 * 근비대로. 사용자 편집(`user_pick`)은 그대로. 처방(`resolveDraft`)과 맨몸 사다리 판정이 같은 값을 봐야 한다.
 */
function draftRepIntent(item: RawDraftItem, profile: UserProfile): (typeof REP_INTENTS)[number] {
  const intent = pick(item.rep_intent, REP_INTENTS, "hypertrophy");
  return profile.experience_level === "beginner" && item.user_pick !== true && intent === "strength" ? "hypertrophy" : intent;
}

// ── Training days (D46 · D56 ②) ──────────────────────────────────────────────

export const ALL_DAYS = [0, 1, 2, 3, 4, 5, 6];

const DAY_MS = 86_400_000;

/**
 * 이번 주 생성에 쓸 프로필([D80] · 백로그 080) — 지난 요일에 운동을 놓지 않는다.
 * 오늘(서버 KST — `access.ts` `generationWeek` 와 같은 기준)이 `weekStartDate` 주 안이면 요일 후보를
 * 가능요일 ∩ 오늘~일로 좁히고(비면 오늘~일 전부 — ②), 회수를 남은 날만큼으로 줄인다(③ · 1이면 전신 1회라
 * 분할 선택은 뺀다). 월요일이거나 다른 주면 그대로다. 프롬프트·요일 배치·회수 검사가 **모두** 이 값을 읽어야
 * 서로 다른 요일을 말하지 않는다 — 생성 루프 입구에서 한 번 만든다.
 */
export function weekProfile(profile: UserProfile, weekStartDate: string, now: number): UserProfile {
  const today = Math.floor((now + 9 * 3_600_000) / DAY_MS) - Date.parse(`${weekStartDate}T00:00:00Z`) / DAY_MS;
  if (!Number.isInteger(today) || today <= 0 || today > 6) return profile;
  const future = ALL_DAYS.filter((d) => d >= today);
  const open = (profile.available_days ?? ALL_DAYS).filter((d) => d >= today);
  const days = open.length > 0 ? open : future;
  const count = Math.min(profile.days_per_week, days.length);
  const { split_pref: _dropped, ...unsplit } = profile;
  return { ...(count < 2 ? unsplit : profile), available_days: days, days_per_week: count };
}

function combinations(list: number[], k: number): number[][] {
  if (k === 0) return [[]];
  return list.flatMap((x, i) => combinations(list.slice(i + 1), k - 1).map((rest) => [x, ...rest]));
}

/** 오름차순 요일 조합의 순환 간격(일→월 포함)과 가장 긴 연속 운동일 수. */
function spacing(days: number[]): { gaps: number[]; run: number } {
  const gaps = days.map((d, i) => (days[(i + 1) % days.length] - d + 7) % 7 || 7);
  let run = 1;
  let longest = 1;
  for (let i = 0; i < gaps.length * 2; i += 1) {
    run = gaps[i % gaps.length] === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }
  return { gaps: [...gaps].sort((a, b) => a - b), run: Math.min(longest, days.length) };
}

/**
 * 가능요일 안에서 근력 요일을 고른다(D46). **요일 간격은 회복 결정이라 코드가 소유한다.**
 * 비교 순서(D56 ②): 가장 좁은 간격이 넓은 조합 → 그 다음 좁은 간격 → 연달아 붙은 날이 짧은
 * 조합 → 이른 요일. 두 번째·세 번째 비교가 없으면 주 4일이 월화수목이 된다.
 * ponytail: 7C3 = 35 조합 전수 — 요일이 7개라 이 이상 커지지 않는다.
 */
export function pickTrainingDays(available: number[], count: number): number[] {
  const pool = [...new Set(available)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (pool.length <= count) return pool;
  let best: number[] = [];
  let bestScore: ReturnType<typeof spacing> | undefined;
  for (const combo of combinations(pool, count)) {
    const score = spacing(combo);
    if (!bestScore || isBetter(score, bestScore)) {
      best = combo;
      bestScore = score;
    }
  }
  return best;
}

/** 조합은 오름차순으로 나오므로 동률이면 먼저 본 것(이른 요일)이 남는다. */
function isBetter(a: ReturnType<typeof spacing>, b: ReturnType<typeof spacing>): boolean {
  for (let i = 0; i < a.gaps.length; i += 1) if (a.gaps[i] !== b.gaps[i]) return a.gaps[i] > b.gaps[i];
  return a.run < b.run;
}

/**
 * LLM 드래프트의 근력 요일을 코드가 고른 요일로 **다시 쓴다**(D46). 생성 때 한 번만 부른다 —
 * 확장(`expandDraftToWeeklyPlan`)은 편집 재확장도 타므로 여기서 배치하면 사용자가 옮긴 요일이
 * 되돌아간다(D56 ②). 근력 요일은 **원래 요일 순서대로** 고른 요일에 붙는다 — 분할 템플릿의
 * 「n번째 훈련일」은 `checkSplitConformance` 가 요일 오름차순으로 센다(배열 순서가 아니다).
 * 휴식·유산소 전용 요일은 버린다 — 확장이 그 요일에서 읽는 것이 없다
 * (`planCardio` 는 드래프트의 유산소 제안을 받지 않는다). 근력 요일 수가 틀리면 손대지 않는다 —
 * `resolveDraft` 의 개수 검사가 LLM 에게 되돌려 보낸다.
 */
export function assignTrainingDays(draft: unknown, profile: UserProfile): unknown {
  const week = (draft as { week?: unknown } | null)?.week;
  if (!Array.isArray(week)) return draft;
  const lifts = (week as RawDraftDay[])
    .filter((d) => typeof d.session_type === "string" && LIFT_SESSIONS.includes(d.session_type))
    .sort((a, b) => Number(a.day_index) - Number(b.day_index));
  const days = pickTrainingDays(profile.available_days ?? ALL_DAYS, profile.days_per_week);
  if (lifts.length !== days.length) return draft;
  return { ...(draft as object), week: lifts.map((d, i) => ({ ...d, day_index: days[i] })) };
}

/**
 * Binds the draft's strength items to catalogue exercises and settles the split.
 * The draft has already passed its JSON schema, so shapes are trusted; ids are
 * not (the MiniMax POC invented them), hence `resolve()`.
 */
export function resolveDraft(
  draft: unknown,
  profile: UserProfile,
  completed: CompletedDay[] = [],
  allowedGeneratedExerciseIds?: readonly string[],
): ResolvedDraft {
  const raw = draft as { split_type?: unknown; week?: unknown };
  const splitType = chooseSplit(profile.days_per_week, profile.split_pref);
  const proposed = typeof raw.split_type === "string" ? raw.split_type : undefined;

  const strength: DraftStrengthItem[] = [];
  const unresolvedIds: string[] = [];
  const problems: string[] = [];
  const days = Array.isArray(raw.week) ? (raw.week as RawDraftDay[]) : [];
  const allowedIds = allowedGeneratedExerciseIds === undefined ? undefined : new Set(allowedGeneratedExerciseIds);
  const generatedEquipment = allowedIds === undefined ? undefined : allowedEquipment(profile);

  // Only an over-long week is wrong. A short week is normal: a 2-day plan may
  // list just its two lifting days rather than padding five rest entries.
  if (days.length > 7) problems.push(`week has ${days.length} days (max 7)`);

  const seenDays = new Set<number>();
  /** 편성 순서대로의 리프팅 요일. 분할 템플릿은 요일이 아니라 **몇 번째 훈련일**에 붙는다. */
  const liftDayIndices: number[] = [];

  for (const day of days) {
    const dayIndex = typeof day.day_index === "number" ? day.day_index : 0;
    if (!Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
      problems.push(`day_index out of range: ${String(day.day_index)}`);
    }
    if (seenDays.has(dayIndex)) problems.push(`duplicate day_index: ${dayIndex}`);
    seenDays.add(dayIndex);

    const sessionType = typeof day.session_type === "string" ? day.session_type : "";
    const isLiftDay = LIFT_SESSIONS.includes(sessionType);
    if (isLiftDay) liftDayIndices.push(dayIndex);

    const items = Array.isArray(day.items) ? (day.items as RawDraftItem[]) : [];
    items.forEach((item, position) => {
      if (item.kind !== "strength") return;
      if (!isLiftDay) {
        // A rest or cardio-only day carrying lifts is a contradiction; expanding
        // it would put working sets on a day the plan calls a rest day.
        problems.push(`strength item on a ${sessionType || "unknown"} day (day_index ${dayIndex})`);
        return;
      }
      const requestedId = typeof item.exercise_id === "string" ? item.exercise_id : "";
      const exercise = requestedId ? resolve(requestedId) : undefined;
      if (!exercise) {
        if (requestedId) unresolvedIds.push(requestedId);
        return;
      }
      // Only AI generation supplies `allowedIds`. Manual edit re-expansion does
      // not, so an explicit user pick keeps its documented equipment escape.
      if (
        allowedIds !== undefined &&
        (!allowedIds.has(exercise.id) ||
          (generatedEquipment !== undefined && !generatedEquipment.has(equipmentFor(exercise, profile))))
      ) {
        problems.push(
          `exercise_id is outside available_exercise_ids/equipment: ${requestedId} -> ${exercise.id} (${exercise.equipment})`,
        );
        return;
      }
      strength.push({
        dayIndex,
        order: typeof item.order === "number" ? item.order : position + 1,
        exercise,
        role: pick(item.role, ROLES, "accessory"),
        repIntent: draftRepIntent(item, profile),
        requestedId,
        ...(typeof item.sets_override === "number" ? { setsOverride: item.sets_override } : {}),
        ...(typeof item.load_kg_override === "number" ? { loadOverride: item.load_kg_override } : {}),
        ...(item.user_pick === true ? { userPick: true } : {}),
      });
    });
  }

  if (liftDayIndices.length !== profile.days_per_week) {
    problems.push(`${liftDayIndices.length} lifting sessions for days_per_week=${profile.days_per_week}`);
  }
  // 가능요일 밖 근력 요일(D46). 생성은 `assignTrainingDays` 가 먼저 배치해 여기 걸리지 않는다 —
  // 걸리는 것은 사용자가 편집으로 옮긴 경우뿐이고, 편집은 문제를 거절 사유로 쓰지 않는다(D20).
  // 개수가 틀리면 `assignTrainingDays` 가 배치를 건너뛴 드래프트다 — 요일까지 보고하면 재시도
  // 프롬프트가 LLM 에게 코드가 정할 요일을 고치라고 시킨다(codex D44 N1 R1).
  else if (profile.available_days) {
    for (const day of liftDayIndices) {
      if (!profile.available_days.includes(day)) problems.push(`lifting day ${day} is not in available_days`);
    }
  }

  problems.push(...checkSplitConformance(strength, liftDayIndices, profile, splitType, completed));

  return {
    splitType,
    ...(proposed && proposed !== splitType ? { overriddenSplit: proposed } : {}),
    strength,
    unresolvedIds,
    problems,
  };
}

/**
 * 완료한 날 뒤에 이어갈 템플릿 슬롯(D60 ② · 044 N2). **요일순 마지막 완료일**의 근력 종목 주근육이
 * 가장 많이 겹치는 슬롯의 **다음** 슬롯이다 — 사용자가 하체를 월요일로 옮겨 완료했으면 화요일은
 * 하체가 아니라 그 다음 부위다(「순서를 지키라는 거지」). 완료 0 이거나 슬롯을 못 찾으면(복근만 한
 * 날 등) 0 = 종전과 같다. 주 안에서만 돈다 — 직전 주는 읽지 않는다(D60 Q6).
 */
export function splitCursor(template: SplitDay[], completed: CompletedDay[]): number {
  const withLifts = completed.filter((c) => c.exercise_ids.length > 0).sort((a, b) => a.day_index - b.day_index);
  const last = withLifts[withLifts.length - 1];
  if (!last) return 0;
  const muscles = last.exercise_ids
    .flatMap((id) => byId(id)?.primary_muscles ?? [])
    .filter((m) => !FLEX_MUSCLES.includes(m));
  let best = -1;
  let bestScore = 0;
  template.forEach((slot, i) => {
    const score = muscles.filter((m) => slot.muscles.includes(m)).length;
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best < 0 ? 0 : (best + 1) % template.length;
}

/**
 * 남은 훈련일 → 템플릿 슬롯(D60 ②). 완료한 요일은 빠진다(저장 때 옛 플랜으로 덮인다 — D60 ①).
 * **마지막 완료일 뒤의 요일이 먼저** 커서(`splitCursor`)부터 이어가고, 그보다 앞의 요일(건너뛴 지난 날)은
 * 그 다음 슬롯을 받는다 — 앞 요일이 커서를 먼저 소비하면 완료한 부위가 바로 다음 훈련일에 다시 온다
 * (codex 044 N2 R1). 완료 0 이면 종전 그대로 첫 훈련일부터 `template[nth]`.
 */
export function slotAssignment(template: SplitDay[], liftDays: number[], completed: CompletedDay[]): Map<number, SplitDay> {
  const done = new Set(completed.map((c) => c.day_index));
  const lastDone = Math.max(-1, ...completed.map((c) => c.day_index));
  const remaining = [...new Set(liftDays)].filter((d) => !done.has(d)).sort((a, b) => a - b);
  const ordered = [...remaining.filter((d) => d > lastDone), ...remaining.filter((d) => d < lastDone)];
  const start = splitCursor(template, completed);
  return new Map(ordered.map((dayIndex, nth) => [dayIndex, template[(start + nth) % template.length]]));
}

/**
 * 분할 준수 검사 — **사용자가 분할을 고른 경우에만** 돈다(D24 · D60 Q5).
 *
 * 고르지 않았으면 종전대로 일수로 분할이 정해지고 요일별 부위는 LLM 자유다.
 * 여기서 규칙을 소급 적용하면 지금 잘 나오던 홈짐·맨몸·동결 앱 경로의 생성이
 * 부위 위반으로 실패하기 시작한다 — 그건 이 작업이 요청받은 범위가 아니다.
 *
 * 템플릿은 요일이 아니라 **몇 번째 훈련일**에 붙는다(`n % 템플릿 길이`). 그래서
 * 훈련일 수가 분할 수의 배수가 아니면 앞 부위부터 다시 돈다(3분할 주4일 =
 * 가슴/등/하체/가슴). **이번 주에 완료한 날이 있으면 그 날은 검사하지 않고**(저장 때 옛
 * 플랜으로 덮인다 — D60 ①) 남은 훈련일은 완료한 부위의 **다음 슬롯부터** 센다(`splitCursor` ·
 * D60 ②). 주를 넘는 커서는 두지 않는다(D60 ④ · D24-1 이 G4 로 남긴 자리).
 *
 * `userPick` 항목은 보지 않는다 — 사용자가 직접 넣은 종목은 볼륨 예산에서도
 * 빠진다(D20-1: 추천일 뿐, 최종 결정은 사용자).
 */
function checkSplitConformance(
  strength: DraftStrengthItem[],
  liftDayIndices: number[],
  profile: UserProfile,
  splitType: SplitType,
  completed: CompletedDay[] = [],
): string[] {
  if (!profile.split_pref) return [];
  const template = splitTemplate(splitType);
  if (!template) return [];

  const problems: string[] = [];
  // 중복 요일은 여기서 접는다. 중복 자체는 이미 별도 problem 이라 어차피 재생성되지만,
  // 접지 않으면 뒤 요일의 `nth` 가 밀려 **엉뚱한 부위 위반**까지 같이 보고된다 —
  // 그 목록이 그대로 재시도 프롬프트가 되므로 모델을 틀린 방향으로 고치게 만든다.
  const dayOf = slotAssignment(template, liftDayIndices, completed);

  const absDays = new Set<number>();
  for (const item of strength) {
    if (item.userPick) continue;
    const day = dayOf.get(item.dayIndex);
    if (!day) continue; // 리프팅 요일이 아닌 곳의 종목은 위에서 이미 problem 이다
    if (item.exercise.primary_muscles.includes("abdominals")) absDays.add(item.dayIndex);
    const offSplit = item.exercise.primary_muscles.filter(
      (muscle) => !day.muscles.includes(muscle) && !FLEX_MUSCLES.includes(muscle),
    );
    if (offSplit.length > 0) {
      problems.push(
        `day ${item.dayIndex} 는 ${day.label} 날인데 ${item.exercise.name_ko}(${offSplit.join(", ")})가 있습니다`,
      );
    }
  }

  // 복근은 어느 날에든 들어갈 수 있지만 **한 날에만** 넣는다(D24).
  if (absDays.size > 1) {
    problems.push(`복근 운동이 ${absDays.size}개 요일에 흩어져 있습니다 — 한 요일에만 넣으세요`);
  }

  return problems;
}

// ── Volume allocation (T2.2) ─────────────────────────────────────────────────

export interface SetAllocation {
  /** Index into the `strength` array the allocation was computed from. */
  itemIndex: number;
  warmupSets: number;
  workingSets: number;
}

export interface VolumePlan {
  /** One entry per **kept** exercise. Dropped items have no allocation. */
  allocations: SetAllocation[];
  /** Weekly working sets charged to each cap group. Always ≤ its cap. */
  weeklySetsByGroup: Record<string, number>;
  /**
   * Items removed because their muscle group already had more exercises than the
   * cap allows sets for — with one set each they would still breach the ceiling.
   * The cap wins: it is a safety limit, the exercise count is not.
   */
  droppedItemIndices: number[];
  /**
   * Groups that finished **below** their MEV anchor, and by how much. Happens
   * when the draft picked too few exercises for a group (one chest lift can hold
   * at most 4 sets, MEV is 8). Reported rather than papered over — B5 decides
   * whether the week is still acceptable.
   */
  shortfallByGroup: Record<string, number>;
}

const ROLE_PRIORITY: Record<DraftStrengthItem["role"], number> = {
  primary: 0,
  secondary: 1,
  accessory: 2,
};

/** Which exercises train each cap group (primary muscles only, design §3.2.1). */
function groupIndex(strength: DraftStrengthItem[], keep: Set<number>): Map<CapGroup, number[]> {
  const byGroup = new Map<CapGroup, number[]>();
  strength.forEach((item, index) => {
    if (!keep.has(index)) return;
    for (const group of capGroupsOf(item.exercise)) {
      const list = byGroup.get(group) ?? [];
      list.push(index);
      byGroup.set(group, list);
    }
  });
  return byGroup;
}

/**
 * Weekly set allocation.
 *
 * 1. Drop exercises a group cannot afford at one set each (cap is a hard limit).
 * 2. Apportion each group's MEV anchor across its exercises — base share plus a
 *    remainder, then clamp to the per-exercise bounds.
 * 3. Trim anything still over cap (possible when a compound serves two groups).
 *
 * **The invariant is `MEV ≤ total ≤ cap`, not `total == MEV`.** MEV is a floor,
 * so overshooting it is fine as long as the cap holds — and it does overshoot
 * when many exercises each need the 2-set minimum (4 biceps lifts → 8 sets for a
 * MEV of 6). Undershooting is the case worth reporting, hence `shortfallByGroup`.
 *
 * Volume is charged on **primary** muscles only. An exercise training two capped
 * groups charges both — that is how the ceiling stays honest for compounds.
 */
/** 중점 부위(D55 ④)의 하체 쪽 상한 그룹. 나머지 다섯이 상체다. */
const LOWER_CAP_GROUPS = new Set<CapGroup>(["quads", "hamstrings", "glutes", "calves"]);

/**
 * 그룹별 주간 세트 목표. 기본은 MEV(하한)에서 시작해 상한 트림으로 끝난다. 중점 부위가
 * 있으면 **그쪽 그룹만 목표를 상한으로** 올리고 반대쪽은 MEV 그대로 — 안전 수치(상한)는
 * 안 바뀐다(INV-1). `balanced`·없음은 종전과 바이트 동일해야 한다(기존 사용자 플랜 불변).
 */
export function volumeTargets(focus?: FocusArea): Record<CapGroup, number> {
  const out = {} as Record<CapGroup, number>;
  for (const group of CAP_GROUPS) {
    const lower = LOWER_CAP_GROUPS.has(group);
    const boosted = (focus === "lower" && lower) || (focus === "upper" && !lower);
    out[group] = boosted ? WEEKLY_VOLUME_CAPS[group] : Math.min(MEV_ANCHORS[group], WEEKLY_VOLUME_CAPS[group]);
  }
  return out;
}

/**
 * 플랜 상단 한 줄(D55 ⑤). **확장이 끝난 `week` 에서 조립한다** — 프로필 플래그로 쓰면 맨몸
 * 환경에 「머신·덤벨 위주」, 바벨이 하나도 안 남은 주에 「빈 바에서 시작」이 찍힌다(거짓말).
 * LLM 문장보다 항상 사실과 맞는 이유가 그것이다. 말할 것이 없으면 `undefined`(필드 없음).
 */
export function presetSummary(
  week: Array<{ exercises: Array<Record<string, unknown>> }>,
  profile: Pick<UserProfile, "experience_level" | "focus_area">,
): string | undefined {
  const lifts = week.flatMap((day) => day.exercises).filter((ex) => ex.modality === "strength" || ex.modality === "bodyweight");
  const equipmentOf = (ex: Record<string, unknown>) => (typeof ex.exercise_id === "string" ? byId(ex.exercise_id)?.equipment : undefined);
  const parts: string[] = [];
  const beginner = profile.experience_level === "beginner";
  if (beginner) parts.push("입문 플랜");
  if (profile.focus_area === "lower") parts.push("하체 중점");
  if (profile.focus_area === "upper") parts.push("상체 중점");
  if (beginner && lifts.length > 0) {
    const friendly = lifts.filter((ex) => ["machine", "cable", "dumbbell", "kettlebells"].includes(equipmentOf(ex) ?? "")).length;
    if (friendly * 2 >= lifts.length) parts.push("머신·덤벨 위주");
    const emptyBar = lifts.some(
      (ex) =>
        equipmentOf(ex) === "barbell" &&
        Array.isArray(ex.sets) &&
        (ex.sets as Array<Record<string, unknown>>).some((s) => s.set_kind === "working" && s.target_load_kg === BEGINNER_START_LOAD_KG.barbell),
    );
    if (emptyBar) parts.push("빈 바에서 시작");
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

export function allocateVolume(strength: DraftStrengthItem[], focus?: FocusArea): VolumePlan {
  const targets = volumeTargets(focus);
  const keep = new Set(strength.map((_, index) => index));
  const dropped: number[] = [];

  // ── 1. Exercise-count budget. Removing an item can only lower other groups'
  // counts, so this converges; the loop just re-checks after each removal.
  for (;;) {
    const byGroup = groupIndex(strength, keep);
    let removedAny = false;
    for (const [group, indices] of byGroup) {
      const budget = WEEKLY_VOLUME_CAPS[group];
      // **사용자가 고른 종목은 예산에 계상하지 않는다**(D20-1: 추천일 뿐).
      // 계상하면 둘 중 하나가 벌어진다 — 사용자 항목이 잘리거나(추가했는데
      // 사라진다), 대신 LLM 항목이 잘린다(안 건드린 줄이 말없이 없어진다).
      // 경고가 없는 이상 둘 다 조용한 거짓말이라, 예산은 **LLM 이 만든 것에만**
      // 적용한다. 생성 경로에는 사용자 항목이 없으므로 동작이 그대로다.
      const budgeted = indices.filter((index) => !strength[index].userPick);
      if (budgeted.length <= budget) continue;
      // Keep the most important lifts: primary before accessory, earlier first.
      const ranked = budgeted.sort((a, b) => {
        const byRole = ROLE_PRIORITY[strength[a].role] - ROLE_PRIORITY[strength[b].role];
        return byRole !== 0 ? byRole : strength[a].order - strength[b].order;
      });
      for (const index of ranked.slice(budget)) {
        keep.delete(index);
        dropped.push(index);
        removedAny = true;
      }
    }
    if (!removedAny) break;
  }

  // ── 2. Apportion MEV per group.
  const byGroup = groupIndex(strength, keep);
  const workingSets = new Map<number, number>();
  for (const index of keep) workingSets.set(index, 0);

  for (const [group, indices] of byGroup) {
    const target = targets[group];
    const base = Math.floor(target / indices.length);
    let remainder = target % indices.length;
    // Give the extra set to the more important lifts first — deterministic.
    const ranked = [...indices].sort((a, b) => {
      const byRole = ROLE_PRIORITY[strength[a].role] - ROLE_PRIORITY[strength[b].role];
      return byRole !== 0 ? byRole : strength[a].order - strength[b].order;
    });
    for (const index of ranked) {
      const share = base + (remainder > 0 ? 1 : 0);
      if (remainder > 0) remainder -= 1;
      // 그 날의 메인(primary)은 최소 3세트 — 그룹 MEV 를 여러 날이 나누면 메인이 2세트가 된다(백로그 12 §4
      // 운동당 2–3세트 · GZCLP T1·GBR 메인 3–4세트). 상한 트림(아래 3)은 그대로 건다.
      const floor = strength[index]!.role === "primary" ? Math.max(3, SETS_PER_EXERCISE.min) : SETS_PER_EXERCISE.min;
      const clamped = Math.min(Math.max(share, floor), SETS_PER_EXERCISE.max);
      // A lift serving two groups takes the larger requirement.
      workingSets.set(index, Math.max(workingSets.get(index) ?? 0, clamped));
    }
  }
  // Exercises no capped group claims (abs, forearms…) still need working sets.
  for (const index of keep) {
    if ((workingSets.get(index) ?? 0) === 0) workingSets.set(index, SETS_PER_EXERCISE.min);
  }

  // ── 3. Cap trim. 예전에는 "step 1 이후 그룹당 최대 cap 개이므로 1세트까지
  // 내리면 반드시 cap 아래"였다. 사용자 항목이 예산 밖에 있게 되면서(위) 그
  // 전제가 깨졌다 — **1세트를 바닥으로 두고 멈춘다.** 안 그러면 0세트짜리 운동이
  // 생겨 계약 스키마를 깨뜨린다. 남는 초과분은 사용자가 자기 플랜에 대해 내린
  // 결정이므로 그대로 둔다(D20-1).
  for (const [group, indices] of byGroup) {
    const cap = WEEKLY_VOLUME_CAPS[group];
    let total = indices.reduce((sum, index) => sum + (workingSets.get(index) ?? 0), 0);
    while (total > cap) {
      const victim = indices.reduce((a, b) =>
        (workingSets.get(a) ?? 0) >= (workingSets.get(b) ?? 0) ? a : b,
      );
      const current = workingSets.get(victim) ?? 1;
      if (current <= 1) break; // 전부 1세트 — 더 내릴 곳이 없다
      workingSets.set(victim, current - 1);
      total -= 1;
    }
  }

  // Warmup sets: the first compound of each session only (design §3.2.1).
  const firstCompoundPerDay = new Map<number, number>();
  strength.forEach((item, index) => {
    if (!keep.has(index) || item.exercise.mechanic !== "compound") return;
    const current = firstCompoundPerDay.get(item.dayIndex);
    if (current === undefined || item.order < strength[current].order) {
      firstCompoundPerDay.set(item.dayIndex, index);
    }
  });
  const warmupIndices = new Set(firstCompoundPerDay.values());

  const allocations: SetAllocation[] = [...keep]
    .sort((a, b) => a - b)
    .map((index) => ({
      itemIndex: index,
      warmupSets: warmupIndices.has(index) ? WARMUP_SETS.max : 0,
      workingSets: workingSets.get(index) ?? SETS_PER_EXERCISE.min,
    }));

  const weeklySetsByGroup = weeklySets(strength, allocations);
  const shortfallByGroup: Record<string, number> = {};
  for (const [group, indices] of byGroup) {
    if (indices.length === 0) continue;
    const missing = MEV_ANCHORS[group] - weeklySetsByGroup[group];
    if (missing > 0) shortfallByGroup[group] = missing;
  }

  return {
    allocations,
    weeklySetsByGroup,
    droppedItemIndices: dropped.sort((a, b) => a - b),
    shortfallByGroup,
  };
}

/** Weekly working sets per cap group — the number the cap is checked against. */
export function weeklySets(
  strength: DraftStrengthItem[],
  allocations: SetAllocation[],
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const group of CAP_GROUPS) totals[group] = 0;

  for (const allocation of allocations) {
    const item = strength[allocation.itemIndex];
    if (!item) continue;
    for (const group of capGroupsOf(item.exercise)) {
      totals[group] += allocation.workingSets;
    }
  }
  return totals;
}

// ── Assembly (B5) ────────────────────────────────────────────────────────────

export interface ExpandResult {
  /** WeeklyPlan v1 — schema- and rule-valid, or `problems` says why not. */
  plan: unknown;
  /** User-facing notes: substitutions, dropped sessions, low-risk cautions. */
  warnings: string[];
  /** Rule violations. Non-empty means the plan must not be returned (S-GEN-8). */
  problems: string[];
  /** 확장이 실제로 쓴 드래프트(맨몸 사다리 반영) — 저장·편집은 이것을 쓴다. */
  draft: unknown;
}

interface PlanSet {
  set_number: number;
  set_kind: "warmup" | "working";
  target_reps_low: number;
  target_reps_high: number;
  target_load_kg: number | null;
  target_load_pct_1rm: number | null;
}

/** Session type is decided by what the day actually holds, not by the draft. */
function sessionTypeOf(hasLifts: boolean, hasCardio: boolean): string {
  if (hasLifts && hasCardio) return "lift_plus_cardio";
  if (hasLifts) return "lift";
  if (hasCardio) return "cardio_only";
  return "rest";
}

/** Rough session length: work time per set plus rest, plus any cardio. */
function estimateDuration(sets: number, restSeconds: number, cardioMin: number): number {
  const WORK_SECONDS_PER_SET = 40;
  return Math.round((sets * (WORK_SECONDS_PER_SET + restSeconds)) / 60) + cardioMin;
}

/**
 * 맨몸 사다리 이동(백로그 02 §3 3)을 **드래프트에** 반영한다 — 운동 선택은 LLM 몫이지만 단계는 기록이
 * 정한다(INV-1). 드래프트를 고치는 이유: 저장되는 드래프트가 편집의 입력이라 플랜만 바꾸면 그 운동을
 * 편집할 때 「그 요일에 없다」가 된다(codex N2 R1). LLM 이 같은 사다리의 다른 칸을 골라도 **지난주
 * 기록한 칸**에서 잇는다 — 안 그러면 매주 처음 칸으로 되돌아간다. 사용자가 고르거나 고친 항목은
 * 건드리지 않는다. **AI 생성 때만 돈다**(`allowedIds` 가 있을 때 — `resolveDraft` 와 같은 관례). 편집
 * 재확장은 이미 옮긴 저장 드래프트를 받으므로 다시 돌리면 같은 기록으로 한 칸 더 오르거나, 생성 후보
 * 밖 칸으로 무관한 편집이 운동을 바꾼다(codex N2 R2).
 */
function applyBodyweightLadder(
  draft: unknown,
  priorLogs: unknown[],
  profile: UserProfile,
  allowedIds: readonly string[] | undefined,
  targetWeek: string,
): { draft: unknown; notes: string[] } {
  const root = draft as { week?: unknown } | null;
  if (allowedIds === undefined || !root || typeof root !== "object" || !Array.isArray(root.week)) return { draft, notes: [] };
  const notes: string[] = [];
  const owned = ownedTools(profile);
  const allowedSet = new Set(allowedIds);
  const logged = (id: string) => priorSetsFor(id, priorLogs).some((set) => set.setKind === "working");
  const week = (root.week as RawDraftDay[]).map((day) => {
    if (!day || !Array.isArray(day.items)) return day;
    const items = (day.items as RawDraftItem[]).map((item) => ({ ...item }));
    const idOf = (item: RawDraftItem) => (typeof item.exercise_id === "string" ? resolve(item.exercise_id)?.id : undefined);
    for (const item of items) {
      if (item.kind !== "strength" || item.user_pick === true) continue;
      if (typeof item.sets_override === "number" || typeof item.load_kg_override === "number") continue;
      const exercise = typeof item.exercise_id === "string" ? resolve(item.exercise_id) : undefined;
      if (exercise?.modality !== "bodyweight") continue;
      const ladder = BODYWEIGHT_LADDERS.find((rungs) => rungs.includes(exercise.id));
      if (!ladder) continue;
      // ponytail: 한 주에 같은 사다리 두 칸을 기록했으면 높은 칸을 잇는다.
      const rung = logged(exercise.id) ? exercise.id : [...ladder].reverse().find(logged);
      if (rung === undefined) continue;
      const taken = new Set(items.filter((o) => o !== item).map(idOf));
      const allowed = (id: string) => {
        const candidate = byId(id);
        return candidate !== undefined && !taken.has(id) && allowedSet.has(id) && allowedByTools(candidate, owned);
      };
      const { min, max } = repRangeFor(draftRepIntent(item, profile), profile.experience_level, exercise.mechanic);
      const step = nextBodyweightStep(rung, priorSetsFor(rung, priorLogs), min, max, allowed,
        BODYWEIGHT_LADDERS, !hasHistoryGap(rung, priorLogs, targetWeek));
      if (step.exerciseId === exercise.id || (step.kind === "hold" && !allowed(rung))) continue;
      const from = byId(rung)!;
      const to = byId(step.exerciseId)!;
      item.exercise_id = to.id;
      // P1 의 이유·대체 운동은 옛 종목 것이다.
      delete item.reason;
      delete item.alternatives;
      if (step.kind === "ladder_up") notes.push(`${from.name_ko} 목표 횟수를 다 채워서 ${to.name_ko}(으)로 올렸어요.`);
      if (step.kind === "ladder_down") notes.push(`${from.name_ko} 목표 횟수를 못 채워서 ${to.name_ko}(으)로 낮췄어요.`);
    }
    return { ...day, items };
  });
  return { draft: { ...root, week }, notes };
}

/**
 * DraftPlan → WeeklyPlan v1. Every number here comes from the engine modules
 * (volume, load, cardio) and every safety filter from `contraindications`.
 *
 * Returns `problems` instead of throwing: the pipeline needs the list to drive
 * its ≤2 repair retries (S-GEN-8), and a thrown error would lose them.
 */
export function expandDraftToWeeklyPlan(input: ExpandInput): ExpandResult {
  const { profile, userId, weekStartDate, weekNumber, priorLogs, disclaimer } = input;
  const laddered = applyBodyweightLadder(input.draft, priorLogs, profile, input.allowedGeneratedExerciseIds, weekStartDate);
  const draft = laddered.draft;

  const resolved = resolveDraft(
    draft,
    profile,
    input.completedThisWeek ?? [],
    input.allowedGeneratedExerciseIds,
  );
  // 증량은 목표가 정한다(ACSM 2026) — 감량·교체는 이 값과 무관하게 항상 돈다.
  // `?? []` 는 dev-server 용이다 — 배포본은 validateProfile 이 goals 를 보장하지만
  // dev-server 는 프로필 검증을 일부러 건너뛴다. 없으면 증량하지 않는다(안전 쪽).
  const allowIncrease = allowsLoadIncrease(profile.goals ?? []);
  const increments = profile.experience_level === "beginner" ? BEGINNER_LOAD_INCREMENT_KG : LOAD_INCREMENT_KG;
  const beginnerFirstWeek = profile.experience_level === "beginner" && priorLogs.length === 0;
  const warnings: string[] = [];
  const problems = [...resolved.problems];

  // S-GEN-7 keys the fallback on **log presence**, not on the week number, so logs
  // are honoured even if the caller numbered the week 1 (e.g. after re-onboarding).
  if (weekNumber <= 1 && priorLogs.length > 0) {
    warnings.push("1주차로 요청되었지만 직전 기록이 있어 진행 결정에 반영했습니다.");
  }

  if (resolved.unresolvedIds.length > 0) {
    warnings.push(
      `카탈로그에 없는 운동 ${resolved.unresolvedIds.length}건을 제외했습니다: ${resolved.unresolvedIds.join(", ")}`,
    );
  }
  if (resolved.overriddenSplit) {
    warnings.push(`분할을 ${resolved.overriddenSplit} 대신 ${resolved.splitType}로 조정했습니다(주당 일수 기준).`);
  }
  // 고른 분할을 일수가 감당하지 못해 강등한 경우(주 3일에 5분할 등). 조용히 바꾸면
  // 사용자는 자기가 고른 분할이 나온 줄 안다.
  if (profile.split_pref && profile.split_pref !== resolved.splitType) {
    warnings.push(
      `주 ${profile.days_per_week}일로는 ${SPLIT_LABEL_KO[profile.split_pref]}을(를) 돌릴 수 없어 ${SPLIT_LABEL_KO[resolved.splitType]}로 맞췄습니다.`,
    );
  }

  warnings.push(...laddered.notes);

  // ── Safety first: contraindicated lifts never reach the volume allocation.
  const contraindicated = contraindicatedMuscles(profile);
  warnings.push(...contraindicated.warnings);
  const filtered = excludeContraindicated(
    resolved.strength,
    profile,
    contraindicated,
    input.allowedGeneratedExerciseIds,
  );
  warnings.push(...filtered.notes);

  // ── Volume, then loads.
  const volume = allocateVolume(filtered.kept, profile.focus_area);
  for (const index of volume.droppedItemIndices) {
    const dropped = filtered.kept[index];
    if (dropped) {
      warnings.push(`${dropped.exercise.name_ko}은(는) 주간 볼륨 상한을 넘어 제외했습니다.`);
    }
  }
  for (const [group, missing] of Object.entries(volume.shortfallByGroup)) {
    warnings.push(`${group} 주간 볼륨이 초보 최소치보다 ${missing}세트 적습니다(운동 수 부족).`);
  }

  // ── Cardio.
  const cardio = planCardio(profile, filtered.kept);
  warnings.push(...cardio.notes);
  // 사용자가 요일 유산소에 내린 결정(`cardio_override`)을 마지막에 덮는다 — 도스 배치는 그대로 돈다.
  const overrides = new Map<number, CardioOverride>();
  for (const day of Array.isArray((draft as { week?: unknown }).week) ? ((draft as { week: RawDraftDay[] }).week) : []) {
    const override = parseCardioOverride(day.cardio_override);
    if (override && typeof day.day_index === "number") overrides.set(day.day_index, override);
  }
  // 줄 id 는 사용자가 고른 운동이다(041 N4) — 13종은 분류→id 가 1:1 이 아니라 분류로 되찾으면 다른 운동이 된다.
  const cardioByDay = new Map<number, Array<{ exerciseId: string; detail: CardioDetail }>>();
  // 서킷(D101 ④): 추천이 서킷이면 유산소 자리를 서킷 묶음으로 — 사용자가 그 날 유산소를 직접 정했으면(편집) 그대로 둔다.
  const circuitFormats = input.circuits ? recommendCardio(profile).circuitFormats : [];
  const circuitByDay = new Map<number, Record<string, unknown>[]>();
  // 템플릿은 처음 고른 것을 드래프트 요일에 고정한다(`circuit_template`) — 다른 날을 편집·비워도 이 날 서킷이
  // 바뀌지 않는다(codex N7a R1·R2). 저장되는 드래프트는 상위집합이다(계약 §2.2).
  const pinned = new Map<number, string>();
  for (const day of Array.isArray((draft as { week?: unknown }).week) ? ((draft as { week: RawDraftDay[] }).week) : []) {
    if (typeof day.day_index === "number" && typeof day.circuit_template === "string") pinned.set(day.day_index, day.circuit_template);
  }
  const banned = new Set(contraindicated.muscles);
  for (const session of applyCardioOverrides(cardio.sessions, overrides, profile, filtered.kept)) {
    if (circuitFormats.length > 0 && !overrides.has(session.dayIndex)) {
      const nth = cardio.sessions.findIndex((s) => s.dayIndex === session.dayIndex);
      const template =
        CIRCUIT_TEMPLATES.find((t) => t.id === pinned.get(session.dayIndex)) ?? circuitTemplateFor(circuitFormats, nth);
      const lifted = new Set(filtered.kept.filter((item) => item.dayIndex === session.dayIndex).map((item) => item.exercise.id));
      const circuitRowsForDay = circuitRows(template, profile.experience_level === "beginner", session.dayIndex, banned, ownedTools(profile), lifted);
      // 부상 금기로 동작이 다 빠지면 그 날은 서킷 대신 보통 유산소다.
      if (circuitRowsForDay.length > 0) {
        circuitByDay.set(session.dayIndex, circuitRowsForDay);
        pinned.set(session.dayIndex, template.id);
        continue;
      }
    }
    const exerciseId = session.exerciseId ?? cardioExerciseId(session.modality);
    // **직전 주 같은 운동 기록이 목표가 된다**([D57] A10 · 041 N6) — 지난주 45분을 뛰었으면 도스표의
    // 30분으로 되돌아가지 않는다. 생성 방식은 안 가린다(사용자 결정 2026-09-16): AI 는 수치를 아예
    // 못 보므로(프롬프트는 비수치 신호만) AI 주라고 해서 지난 기록이 반영돼 있지는 않다.
    // **사용자가 그 날 목표를 직접 넣었으면 그게 이긴다**(T6-6) — 복사는 비어 있는 자리를 채우는 것이다.
    const decided = overrides.get(session.dayIndex);
    const userTarget = decided && decided !== "none" ? decided.target : undefined;
    if (!userTarget) {
      const prior = cardioTargetFromPriorLogs(exerciseId, priorLogs);
      if (prior) applyCardioTarget(session, prior);
    }
    const list = cardioByDay.get(session.dayIndex) ?? [];
    list.push({ exerciseId, detail: toCardioDetail(session) });
    cardioByDay.set(session.dayIndex, list);
  }

  // ── Per-day assembly.
  const allocationByIndex = new Map(volume.allocations.map((a) => [a.itemIndex, a]));
  const dayIndices = [...new Set([...filtered.kept.map((i) => i.dayIndex), ...cardioByDay.keys(), ...circuitByDay.keys()])].sort(
    (a, b) => a - b,
  );

  const week = dayIndices.map((dayIndex) => {
    const lifts = filtered.kept
      .map((item, index) => ({ item, allocation: allocationByIndex.get(index) }))
      .filter((entry) => entry.item.dayIndex === dayIndex && entry.allocation !== undefined)
      .sort((a, b) => a.item.order - b.item.order);

    let totalSets = 0;
    let restForEstimate = 0;
    const exercises: Record<string, unknown>[] = lifts.map((entry, position) => {
      const { item, allocation } = entry;
      const prescription = prescribeLoad(item.exercise, priorLogs, item.repIntent, allowIncrease, profile.experience_level, weekStartDate);
      const sets: PlanSet[] = [];

      for (let i = 0; i < allocation!.warmupSets; i += 1) {
        sets.push({
          set_number: sets.length + 1,
          set_kind: "warmup",
          target_reps_low: prescription.repsLow,
          target_reps_high: prescription.repsHigh,
          // Warmups are deliberately unloaded targets — the user ramps up.
          target_load_kg: null,
          target_load_pct_1rm: null,
        });
      }
      // A `substitute` decision means this lift should be swapped, so it carries no
      // target load — the app's exercise-swap flow (002 FR-ADJ-1) takes over.
      const substituting = prescription.progression?.decision === "substitute";
      // 사용자가 정한 값이 있으면 그것으로 그린다. %1RM 은 같이 못 옮긴다 — 사용자는
      // kg 을 말했지 1RM 비율을 말한 게 아니다. 지어내느니 비운다.
      const workingCount = item.setsOverride ?? allocation!.workingSets;
      const targetLoad = item.loadOverride ?? (substituting ? null : prescription.targetLoadKg);
      for (let i = 0; i < workingCount; i += 1) {
        sets.push({
          set_number: sets.length + 1,
          set_kind: "working",
          target_reps_low: prescription.repsLow,
          target_reps_high: prescription.repsHigh,
          target_load_kg: targetLoad,
          target_load_pct_1rm:
            item.loadOverride !== undefined ? null : substituting ? null : prescription.targetLoadPct1rm,
        });
      }
      if (substituting) {
        warnings.push(
          `${item.exercise.name_ko}은(는) 더 낮출 무게가 없어 교체를 권합니다(앱에서 대체 운동을 선택하세요).`,
        );
      }

      totalSets += sets.length;
      restForEstimate = Math.max(restForEstimate, prescription.restSeconds);

      // 무게를 사용자가 정했으면 진행 결정은 그 처방을 더 이상 설명하지 못한다 —
      // 그대로 두면 `checkPlanRules` 가 "target 이 decision 과 다르다"로 거절한다.
      const decision: ProgressionDecision | null =
        item.loadOverride !== undefined ? null : prescription.progression;
      return {
        exercise_id: item.exercise.id,
        name: item.exercise.name_ko,
        modality: item.exercise.modality,
        primary_muscles: item.exercise.primary_muscles,
        order: position + 1,
        rest_seconds: prescription.restSeconds,
        progression_method: "double_progression",
        progression_decision: decision,
        sets,
      };
    });

    const cardioDetails = cardioByDay.get(dayIndex) ?? [];
    const circuit = circuitByDay.get(dayIndex) ?? [];
    const cardioMinutes =
      cardioDetails.reduce((sum, { detail }) => sum + detail.duration_min, 0) +
      (circuit.length > 0 ? Number((circuit[0]!.circuit as { minutes?: number }).minutes ?? 0) : 0);
    // 서킷은 근력 뒤, 유산소 자리다. 분(minutes)은 소요 추정에만 쓰고 저장하지 않는다.
    for (const row of circuit) {
      const { minutes: _m, ...meta } = row.circuit as Record<string, unknown>;
      exercises.push({ ...row, circuit: meta, order: exercises.length + 1 });
    }
    // Base captured before the loop: reading `exercises.length` each iteration
    // makes the order skip numbers once a day holds two cardio sessions.
    const cardioOrderBase = exercises.length;
    cardioDetails.forEach(({ exerciseId, detail }, position) => {
      exercises.push({
        exercise_id: exerciseId,
        name: cardioName(exerciseId),
        modality: "cardio",
        order: cardioOrderBase + position + 1,
        cardio_detail: detail,
      });
    });

    return {
      day_index: dayIndex,
      session_type: sessionTypeOf(lifts.length > 0, cardioDetails.length > 0 || circuit.length > 0),
      focus: focusLabel(exercises),
      est_duration_min: estimateDuration(totalSets, restForEstimate, cardioMinutes),
      warmup_note:
        "첫 복합운동 전 가벼운 무게로 1–2세트 워밍업하세요." +
        // 입문 첫 주(이력 없음): 시작값이 낮은 이유와 올리는 법을 플랜이 직접 말한다(D55 ②).
        // 렙 수는 안 적는다 — 종목마다 다르고, 그 값은 세트 카드가 보여 준다.
        (beginnerFirstWeek
          ? " 입문 첫 주는 빈 바·가벼운 덤벨부터 시작해요. 쉬우면 세트마다 한 단계씩 올려 목표 횟수가 힘들어지는 무게를 기록하세요. 머신은 가장 가벼운 핀부터."
          : ""),
      exercises,
    };
  });

  const presetLine = presetSummary(week as Array<{ exercises: Array<Record<string, unknown>> }>, profile);
  const plan = {
    schema_version: "1.0",
    plan_meta: {
      plan_id: `${userId}-w${weekNumber}`,
      user_id: userId,
      week_start_date: weekStartDate,
      week_number: weekNumber,
      // 아티팩트는 대표 목표 하나(`goal`)와 전체(`goals`)를 함께 싣는다 — 동결된
      // Flutter 앱과 기존 요약 픽스처가 `goal` 을 읽는다.
      goal: profile.goals[0],
      goals: profile.goals,
      experience_level: profile.experience_level,
      split_type: resolved.splitType,
      days_per_week: input.planDaysPerWeek ?? profile.days_per_week,
      generated_at: new Date().toISOString(),
      // 확장이 끝난 `week` 를 읽어 만든다 — 아래 `week` 상수가 이미 완성돼 있다.
      ...(presetLine === undefined ? {} : { preset_summary: presetLine }),
      ...(input.source === undefined ? {} : { source: input.source }),
      disclaimer,
    },
    week,
    progression: {
      method: "double_progression" as const,
      // 주 단위 숫자 두 개라 **바벨 값**이다(D55 ①). 덤벨·케틀벨 +2kg 는 필드로 못
      // 실으므로 아래 문장에 적는다 — 처방과 다른 숫자를 싣는 것이 아티팩트의 거짓말이다.
      load_increment_upper_kg: increments.upper,
      load_increment_lower_kg: increments.lower,
      advance_rule:
        (allowIncrease
          ? "모든 워킹 세트에서 목표 렙 상단을 실패 없이 달성하면 다음 주에 무게를 한 단계 올립니다. "
          : "목표가 증량형이 아니라 무게는 유지하고, 렙을 목표 범위 안에서 늘려갑니다. ") +
        `덤벨·케틀벨은 ${HAND_LOAD.incrementKg}kg 씩입니다. ` +
        "통증이 기록되면 무게를 낮추거나 운동을 교체합니다.",
    },
    safety: {
      disclaimer,
      excluded_exercise_ids: filtered.excludedExerciseIds,
      weekly_volume_caps: WEEKLY_VOLUME_CAPS,
    },
  };

  problems.push(...checkPlanRules(plan, profile.days_per_week));
  // 고른 서킷 템플릿을 저장 드래프트의 그 요일에 남긴다 — 재확장이 같은 서킷을 낸다.
  const pinnedDraft =
    pinned.size === 0
      ? draft
      : {
          ...(draft as object),
          week: ((draft as { week?: RawDraftDay[] }).week ?? []).map((d) =>
            typeof d.day_index === "number" && pinned.has(d.day_index) ? { ...d, circuit_template: pinned.get(d.day_index) } : d,
          ),
        };
  return { plan, warnings, problems, draft: pinnedDraft };
}

/**
 * 서킷 한 세션의 운동 줄(WeeklyPlan v1 · `circuit` 묶음). A 는 라운드마다 `target_seconds`, B·C 는 세트마다 렙
 * (`target_reps_low = high`). 무게·진행 결정은 없다(맨몸 · INV-1). 템플릿은 호출 층이 정한다(고정값 또는 회전).
 */
function circuitRows(
  template: CircuitTemplate,
  beginner: boolean,
  dayIndex: number,
  banned: ReadonlySet<string>,
  tools: ReadonlySet<string> | undefined,
  /** 그 날 근력 종목 id — 같은 id 가 한 날에 두 줄이면 기록(종목 id 키)이 섞인다. 서킷에서 뺀다. */
  lifted: ReadonlySet<string>,
): Record<string, unknown>[] {
  // 부상 부위를 쓰는 동작은 뺀다(S-GEN-4 — 근력과 같은 금기 규칙).
  // 보유 도구 밖 동작(스텝·의자 등 `requires`)도 뺀다 — 근력 후보와 같은 규칙(G0 Q1 · codex N7a R4).
  const moves = expandCircuit(template, beginner).filter(
    (m) =>
      !contraindicationTags(byId(m.exercise_id)!).some((muscle) => banned.has(muscle)) &&
      allowedByTools(byId(m.exercise_id)!, tools) &&
      !lifted.has(m.exercise_id),
  );
  if (moves.length === 0) return [];
  const rounds = Math.max(...moves.map((m) => m.sets.length));
  const meta = {
    id: `d${dayIndex}-${template.id}`,
    format: template.format,
    rounds,
    name: template.name + (beginner ? " · 입문" : ""),
    source_url: template.source_url,
    minutes: circuitMinutes(moves),
  };
  return moves.map((move) => {
    const exercise = byId(move.exercise_id)!;
    return {
      exercise_id: exercise.id,
      name: exercise.name_ko,
      modality: exercise.modality,
      primary_muscles: exercise.primary_muscles,
      rest_seconds: move.rest_seconds,
      progression_method: "none",
      progression_decision: null,
      circuit: meta,
      sets: move.sets.map((set, i) =>
        "seconds" in set
          ? { set_number: i + 1, set_kind: "working", target_seconds: set.seconds }
          : { set_number: i + 1, set_kind: "working", target_reps_low: set.reps, target_reps_high: set.reps, target_load_kg: null, target_load_pct_1rm: null },
      ),
    };
  });
}

function cardioName(exerciseId: string): string {
  return resolve(exerciseId)?.name_ko ?? exerciseId;
}

/**
 * 요일 제목(`focus`) — 코드가 소유한다(백로그 011). LLM 이 쓰던 시절엔 길이 규정이
 * 없어 화면에서 두 줄로 넘쳤다. 그날 배정된 근육군은 이미 여기 있으므로 요청할
 * 이유가 없다: 세트 수로 랭킹해 상위 2개를 `+` 로 잇고, 3개 이상이면 접는다.
 * 배열 순서가 곧 동률 타이브레이크다(결정론).
 */
const MUSCLE_GROUPS: Array<[string, string[]]> = [
  ["가슴", ["chest"]],
  ["등", ["lats", "middle back", "lower back", "traps"]],
  ["어깨", ["shoulders"]],
  ["하체", ["quadriceps", "hamstrings", "glutes", "calves", "abductors", "adductors"]],
  ["이두", ["biceps"]],
  ["삼두", ["triceps"]],
  ["복근", ["abdominals"]],
  ["전완", ["forearms"]],
  ["목", ["neck"]],
];
const GROUP_ORDER = MUSCLE_GROUPS.map(([group]) => group);
const GROUP_OF = new Map(MUSCLE_GROUPS.flatMap(([group, muscles]) => muscles.map((m) => [m, group] as const)));
/**
 * 팔·복근은 **보조**다 — 주 부위(가슴·등·어깨·하체)와 섞이면 제목을 차지하지 않는다.
 * 그래야 PPL 주간에서 푸시/풀이 둘 다 "상체"로 뭉개지지 않는다.
 */
const MAIN_GROUPS = new Set(["가슴", "등", "어깨", "하체"]);

export function focusLabel(exercises: Array<Record<string, unknown>>): string {
  const setsByGroup = new Map<string, number>();
  for (const exercise of exercises) {
    if (exercise.modality === "cardio") continue;
    const muscles = Array.isArray(exercise.primary_muscles) ? (exercise.primary_muscles as string[]) : [];
    const sets = Array.isArray(exercise.sets) ? (exercise.sets as PlanSet[]) : [];
    const working = sets.filter((set) => set.set_kind === "working").length;
    // 한 운동이 같은 그룹의 근육을 둘 이상 쓰더라도 세트는 한 번만 센다.
    for (const group of new Set(muscles.map((m) => GROUP_OF.get(m)).filter((g): g is string => !!g))) {
      setsByGroup.set(group, (setsByGroup.get(group) ?? 0) + working);
    }
  }
  if (setsByGroup.size === 0) return "유산소";

  const rank = (predicate: (group: string) => boolean) =>
    [...setsByGroup.keys()].filter(predicate).sort(
      (a, b) =>
        (setsByGroup.get(b) ?? 0) - (setsByGroup.get(a) ?? 0) ||
        GROUP_ORDER.indexOf(a) - GROUP_ORDER.indexOf(b),
    );
  const main = rank((g) => MAIN_GROUPS.has(g));
  const accessory = rank((g) => !MAIN_GROUPS.has(g));

  // 주 부위가 없는 날은 보조가 제목이 된다 — 팔 전담일·복근일.
  if (main.length === 0) return accessory.slice(0, 2).join(" + ");
  if (main.length === 1) return accessory.length > 0 ? `${main[0]} + ${accessory[0]}` : main[0]!;
  if (main.length === 2) return main.join(" + ");
  // 주 부위가 3개 이상이면 접는다 — 상위 2개만 남기면 안 적힌 부위를 그날 하게 된다.
  return main.includes("하체") ? "전신" : "상체";
}
