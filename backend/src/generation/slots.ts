/**
 * P1 골격([ADR-0025] · [D104] ④) — 요일별 움직임 패턴 슬롯·순서·종목 수·역할·렙 의도를 코드가 정하고,
 * LLM 은 슬롯마다 여기서 준 후보 중 하나만 고른다.
 *
 * 슬롯 순서는 출처의 공통 구조다: 메인 복합 → 보조 복합 → 고립 · 큰 근육 → 작은 근육 · 주간 6패턴
 * (스쿼트·힌지·수평/수직 밀기·수평/수직 당기기). 템플릿 근거는 백로그 운동목록 12 §3.
 * 세션 길이는 웨이트만 센다(D104 ③). 분할은 사용자가 고른 값, 아니면 일수(D104 ① · `chooseSplit`).
 */
import { BEGINNER_EQUIPMENT_RANK, byId, contraindicationTags, generationPool, type Exercise } from "../data/exercises";
import { PATTERN_RANK, type Pattern } from "../data/exercise-rank";
import { FLEX_MUSCLES, chooseSplit, splitTemplate, type SplitType } from "../data/splits";
import { contraindicatedMuscles } from "./contraindications";
import { ALL_DAYS, pickTrainingDays, slotAssignment, splitCursor } from "./expand";
import type { CompletedDay, UserProfile } from "./types";

export type { Pattern };

export interface Slot {
  /** 드래프트가 되짚는 키(`d{요일순}s{슬롯순}`). */
  key: string;
  pattern: Pattern;
  role: "primary" | "secondary" | "accessory";
  repIntent: "strength" | "hypertrophy";
  /** 순위순. 첫 번째가 기본 선택이다. */
  candidates: string[];
}

export interface SkeletonDay {
  label: string;
  slots: Slot[];
}

/** 패턴 하나 + 후보가 없을 때 차례로 시도할 대체 패턴. */
type SlotDef = [Pattern, ...Pattern[]];

interface DayDef {
  label: string;
  /** 허용 주근육 — 사용자가 분할을 고른 날은 `splits.ts` 템플릿 그대로(분할 준수 검사와 같은 표). */
  muscles?: string[];
  /** 보충(FILLER)에서 뺄 패턴 — 밀기·당기기 날이 반대쪽으로 채워지지 않게(codex N9 R6). */
  noFill?: Pattern[];
  slots: SlotDef[];
}

const COMPOUND: ReadonlySet<Pattern> = new Set(["squat", "hinge", "lunge", "glute", "h_push", "v_push", "h_pull", "v_pull"]);

// 전신 A/B — StrengthLog 머신 2일 · Fierce 5 · BBR(6패턴을 두 세션에 나눈다). 백로그 12 §3.1.
// 5종목이면 A 는 밀기 1·당기기 2, B 는 밀기 2·당기기 1 — 두 날을 합쳐 6패턴이 다 들어가고 밀기:당기기 = 1.
const FULL_A: DayDef = {
  label: "전신 A",
  slots: [["squat", "lunge"], ["h_push"], ["v_pull", "h_pull"], ["hinge", "glute"], ["h_pull"], ["v_push", "h_push"], ["core"], ["lat_raise"], ["triceps"], ["leg_curl", "glute"]],
};
const FULL_B: DayDef = {
  label: "전신 B",
  slots: [["hinge", "glute"], ["v_push", "h_push"], ["h_pull"], ["squat", "lunge"], ["h_push"], ["v_pull", "h_pull"], ["core"], ["biceps"], ["calf"], ["rear_delt"]],
};
// 자동 분할 날의 허용 근육 — 보충(FILLER)이 그 날 부위 밖으로 나가지 않게(codex N9 R3). 이름은 카탈로그 17-값.
const LEG_MUSCLES = ["quadriceps", "hamstrings", "glutes", "calves", "abductors", "adductors"];
const UPPER_MUSCLES = ["chest", "lats", "middle back", "lower back", "traps", "shoulders", "biceps", "triceps", "forearms"];
const UPPER: DayDef = {
  label: "상체",
  muscles: UPPER_MUSCLES,
  slots: [["h_push"], ["v_pull", "h_pull"], ["v_push", "h_push"], ["h_pull"], ["lat_raise"], ["biceps"], ["triceps"], ["rear_delt"], ["chest_iso"], ["core"]],
};
const LOWER: DayDef = {
  label: "하체",
  muscles: [...LEG_MUSCLES, "lower back"],
  slots: [["squat", "lunge"], ["hinge", "glute"], ["lunge", "squat"], ["leg_curl", "glute"], ["calf"], ["core"], ["leg_ext"], ["glute", "hinge"], ["abduction"]],
};
const PUSH: DayDef = {
  label: "밀기",
  muscles: ["chest", "shoulders", "triceps"],
  noFill: ["rear_delt", "h_pull", "v_pull", "biceps"],
  slots: [["h_push"], ["v_push", "h_push"], ["h_push"], ["lat_raise"], ["triceps"], ["chest_iso"], ["triceps"], ["lat_raise"], ["core"]],
};
const PULL: DayDef = {
  label: "당기기",
  muscles: ["lats", "middle back", "lower back", "traps", "biceps", "forearms", "shoulders", "hamstrings", "glutes"],
  noFill: ["h_push", "v_push", "chest_iso", "triceps", "lat_raise"],
  slots: [["v_pull", "h_pull"], ["h_pull"], ["rear_delt"], ["biceps"], ["h_pull", "v_pull"], ["biceps"], ["core"], ["rear_delt"], ["hinge", "glute"]],
};
const LEGS: DayDef = {
  label: "하체",
  muscles: [...LEG_MUSCLES, "lower back"],
  slots: [["squat", "lunge"], ["hinge", "glute"], ["lunge", "squat"], ["leg_curl", "glute"], ["calf"], ["leg_ext"], ["core"], ["glute", "hinge"], ["abduction"]],
};

/** 사용자가 고른 부위별 분할 — 근육은 `splits.ts`, 슬롯은 그 날 부위의 패턴. */
const PART_SLOTS: Record<string, SlotDef[]> = {
  // 최대 종목 수(7) + 중점 +1 = 8칸 이상을 둔다 — 모자라면 75·90분이 목표 수를 못 채운다(codex N8a R2).
  "가슴·삼두": [["h_push"], ["h_push"], ["chest_iso"], ["triceps"], ["h_push"], ["triceps"], ["chest_iso"], ["triceps"]],
  "등·이두": [["v_pull", "h_pull"], ["h_pull"], ["h_pull", "v_pull"], ["biceps"], ["v_pull", "h_pull"], ["biceps"], ["h_pull"], ["biceps"]],
  "하체·어깨": [["squat", "lunge"], ["hinge", "glute"], ["v_push"], ["lunge", "squat"], ["lat_raise"], ["leg_curl", "glute"], ["calf"], ["rear_delt"]],
  어깨: [["v_push"], ["lat_raise"], ["rear_delt"], ["v_push"], ["lat_raise"], ["rear_delt"], ["v_push"], ["lat_raise"]],
  하체: LEGS.slots,
  가슴: [["h_push"], ["h_push"], ["chest_iso"], ["h_push"], ["chest_iso"], ["h_push"], ["chest_iso"], ["h_push"]],
  등: [["v_pull", "h_pull"], ["h_pull"], ["h_pull", "v_pull"], ["v_pull", "h_pull"], ["h_pull"], ["h_pull"], ["v_pull", "h_pull"], ["h_pull"]],
  팔: [["biceps"], ["triceps"], ["biceps"], ["triceps"], ["biceps"], ["triceps"], ["biceps"], ["triceps"]],
  상체: UPPER.slots,
};

function dayDefs(split: SplitType, days: number): DayDef[] {
  const template = splitTemplate(split);
  if (template) return template.map((d) => ({ label: d.label, muscles: d.muscles, slots: PART_SLOTS[d.label] ?? FULL_A.slots }));
  if (split === "full_body") return [FULL_A, FULL_B];
  // 5일은 상·하체 + PPL(Nippard 5일 · 백로그 12 §3.2), 6일은 PPL ×2.
  return days === 5 ? [UPPER, LOWER, PUSH, PULL, LEGS] : [PUSH, PULL, LEGS];
}

/** 대체 패턴이 그 날 겹칠 때 바꿔 넣을 같은 쪽 패턴(마지막은 같은 패턴의 다른 운동). */
const SAME_SIDE: Partial<Record<Pattern, Pattern[]>> = {
  h_pull: ["rear_delt", "biceps", "h_pull"],
  v_pull: ["rear_delt", "biceps", "v_pull"],
  h_push: ["triceps", "chest_iso", "h_push"],
  v_push: ["lat_raise", "triceps", "v_push"],
  lunge: ["glute", "lunge"],
  squat: ["lunge", "squat"],
  glute: ["leg_curl", "glute"],
  hinge: ["glute", "leg_curl", "hinge"],
};

/** 템플릿이 다 떨어졌을 때 보충할 패턴 — 큰 패턴 → 작은 패턴. */
const FILLER: Pattern[] = [
  "lunge", "glute", "hinge", "squat", "h_pull", "v_pull", "h_push", "v_push", "core",
  "triceps", "biceps", "calf", "rear_delt", "lat_raise", "chest_iso", "leg_curl", "leg_ext", "abduction",
];

/** 웨이트 종목 수(D104 ③ — 유산소는 따로 붙는다). 백로그 12 §4 초급 4–6 · 중급 5–8. */
export const SESSION_EXERCISES: Record<UserProfile["session_len_min"], number> = { 30: 4, 45: 5, 60: 6, 75: 7, 90: 7 };

const CURATED = new Map<string, Pattern>(
  (Object.entries(PATTERN_RANK) as Array<[Pattern, string[]]>).flatMap(([pattern, ids]) => ids.map((id) => [id, pattern] as [string, Pattern])),
);
/** 근력 슬롯에 맞지 않는 동작 — 올림픽 리프트·점프·스윙(서킷·파워 종목). */
const NOT_A_SLOT = /clean|jerk|snatch|swing|burpee|jump|thruster|get.up|sprint|kick|flutter|muscle.up|rope.climb|sled|battling|wiper|side plank|clock|single.arm push|twist|band/;
const SINGLE_LEG = /lunge|split.squat|step.?up|bulgarian/;

/**
 * 종목 → 패턴. 큐레이션 표(`PATTERN_RANK`)가 먼저고, 없으면 카탈로그(주근육·복합/고립·밀기/당기기)로 정한다.
 * ponytail: 이름 정규식 근사 — 오분류가 보이면 그 종목을 큐레이션 표에 넣어 덮는다.
 */
export function patternOf(exercise: Exercise): Pattern | null {
  const curated = CURATED.get(exercise.id);
  if (curated) return curated;
  if (exercise.category !== "strength" && exercise.category !== "powerlifting") return null;
  const name = exercise.name.toLowerCase();
  if (NOT_A_SLOT.test(name)) return null;
  const primary = exercise.primary_muscles[0];
  if (primary === "abdominals") return "core";
  if (exercise.mechanic === "compound") {
    switch (primary) {
      case "quadriceps":
        return SINGLE_LEG.test(name) ? "lunge" : "squat";
      case "glutes":
        if (/thrust|bridge/.test(name)) return "glute";
        return SINGLE_LEG.test(name) ? "lunge" : /squat|leg press/.test(name) ? "squat" : "hinge";
      case "hamstrings":
      case "lower back":
        return "hinge";
      case "chest":
        return "h_push";
      case "shoulders":
        return /rear|face pull|reverse/.test(name) ? "rear_delt" : exercise.force === "push" ? "v_push" : null;
      case "lats":
        return /pulldown|pull.?up|chin/.test(name) ? "v_pull" : "h_pull";
      case "middle back":
        return "h_pull";
      case "triceps":
        return "triceps";
      case "biceps":
        return "biceps";
      default:
        return null;
    }
  }
  if (exercise.mechanic !== "isolation") return null;
  switch (primary) {
    case "chest":
      return "chest_iso";
    case "shoulders":
      // 「후면」을 먼저 본다 — 누워서 하는 후면 레터럴 레이즈가 측면으로 분류되던 것(codex N9 R2).
      return /rear|reverse fly|face pull/.test(name) ? "rear_delt" : /lateral|side/.test(name) ? "lat_raise" : null;
    case "biceps":
      return "biceps";
    case "triceps":
      return "triceps";
    case "hamstrings":
      return /curl/.test(name) ? "leg_curl" : null;
    case "quadriceps":
      return /extension/.test(name) ? "leg_ext" : null;
    case "calves":
      return /calf/.test(name) ? "calf" : null;
    case "abductors":
      return "abduction";
    default:
      return null;
  }
}

/** 슬롯 하나에 싣는 후보 수 — 후보 표가 프롬프트의 대부분이라 작게 둔다. */
const PER_SLOT = 6;

/**
 * 패턴 → 순위순 후보 id. 장비·도구·입문자 프리셋은 `generationPool`, 부상은 금기 근육, 분할을 고른 날은 그 날 근육.
 * 직전 주에 한 종목(`recent`)이 이 패턴이면 맨 앞이다 — 코어 종목 연속성(D55 ⑥ · T8-5).
 */
export function slotCandidates(
  pattern: Pattern,
  profile: UserProfile,
  options: { recent?: readonly string[]; muscles?: readonly string[]; noBarbell?: boolean; exclude?: ReadonlySet<string> } = {},
): string[] {
  const { usable } = generationPool(profile);
  const banned = new Set(contraindicatedMuscles(profile).muscles);
  const allowedMuscles = options.muscles ? new Set([...options.muscles, ...FLEX_MUSCLES]) : undefined;
  const beginner = profile.experience_level === "beginner";
  const curated = PATTERN_RANK[pattern];
  const recent = new Set(options.recent ?? []);
  const rank = (e: Exercise) => {
    const i = curated.indexOf(e.id);
    return i < 0 ? curated.length : i;
  };
  return usable
    .filter((e) => patternOf(e) === pattern)
    .filter((e) => !contraindicationTags(e).some((m) => banned.has(m)))
    .filter((e) => !allowedMuscles || e.primary_muscles.every((m) => allowedMuscles.has(m)))
    // 입문자 바벨 복합은 세션당 1개까지(D55 ①) — 그 날 메인 슬롯에만 남긴다. 연속성 종목은 예외(D55 ⑥).
    .filter((e) => !options.noBarbell || e.equipment !== "barbell" || recent.has(e.id))
    // 같은 날 이미 고른 운동은 자르기 전에 뺀다 — 반복 보충이 같은 상위 6개만 받던 것(codex N9 R5).
    .filter((e) => !options.exclude?.has(e.id))
    .sort(
      (a, b) =>
        Number(recent.has(b.id)) - Number(recent.has(a.id)) ||
        // 입문자는 머신·케이블·덤벨이 먼저(D55 ①), 그다음 큐레이션 순위.
        (beginner ? (BEGINNER_EQUIPMENT_RANK[a.equipment] ?? 9) - (BEGINNER_EQUIPMENT_RANK[b.equipment] ?? 9) : 0) ||
        rank(a) - rank(b) ||
        Number(a.level !== "beginner") - Number(b.level !== "beginner") ||
        a.id.localeCompare(b.id),
    )
    .slice(0, PER_SLOT)
    .map((e) => e.id);
}

/**
 * 프로필 → 이번 주 근력일 골격. 날 수는 `days_per_week`(`weekProfile`), k번째 날은 k번째 훈련일이고 분할을 고른 사용자면
 * 그 부위를 확장의 분할 검사·P0 프롬프트와 **같은 함수**(`slotAssignment`)로 정한다 — 완료한 날을 건너뛰고 남은 날에 잇는다(D60 ②).
 * 완료한 날이 오늘이면 그 날이 훈련일에 남는데, 따로 세면 골격이 한 칸 밀려 검사가 전부 실패했다(2026-10-19 보고).
 * 완료한 날 자리는 그 날 한 부위(커서 직전)로 채운다 — 저장 직전 옛 플랜으로 되살아나 버려진다(D60 ①).
 */
export function buildSkeleton(
  profile: UserProfile,
  options: { recent?: readonly string[]; completed?: CompletedDay[] } = {},
): SkeletonDay[] {
  const split = chooseSplit(profile.days_per_week, profile.split_pref);
  const defs = dayDefs(split, profile.days_per_week);
  const shapes = defs.map((d) => ({ label: d.label, muscles: d.muscles ?? [] }));
  const cursor = splitCursor(shapes, options.completed ?? []);
  const trainingDays = pickTrainingDays(profile.available_days ?? ALL_DAYS, profile.days_per_week);
  // 분할을 고른 사용자만 — 검사·프롬프트도 그때만 요일별 부위를 말한다. 안 골랐으면 종전 차례 그대로(D60 Q5).
  const slotOf = profile.split_pref ? slotAssignment(shapes, trainingDays, options.completed ?? []) : undefined;
  const count = SESSION_EXERCISES[profile.session_len_min] ?? 5;
  const focus = profile.focus_area;
  const beginner = profile.experience_level === "beginner";
  const strengthGoal = profile.goals[0] === "gain_strength";
  // 이번 주에 이미 복근을 했으면 남은 날엔 넣지 않는다(D24-1 · 재생성).
  let coreUsed = (options.completed ?? []).some((c) => c.exercise_ids.some((id) => byId(id)?.primary_muscles.includes("abdominals")));
  // 같은 패턴이 주에 다시 나오면(메인 제외) 후보 순서를 한 칸씩 돌린다 — 「같은 슬롯, 날마다 다른 변형」(Nuckols ·
  // 백로그 12 §1). 기본 선택이 매일 같은 운동이던 것(N9 실측 · 맨몸). 직전 주 종목이 맨 앞이면(연속성) 돌리지 않는다.
  const seen = new Map<Pattern, number>();
  const injured = contraindicatedMuscles(profile).muscles.length > 0;
  // 부상이 후보를 줄였는가 — 부상을 빼고 다시 센 후보가 더 많아야 부상 때문이다(codex N9 R1: 목 부상이 힌지를 지우던 것).
  // 분할 근육·바벨 제한은 같은 조건으로 센다 — 그 영향을 부상 탓으로 오판하지 않게(codex N9 R2).
  const reducedByInjury = (pattern: Pattern, count: number, opts: { muscles?: readonly string[]; noBarbell?: boolean; exclude?: ReadonlySet<string> }) =>
    slotCandidates(pattern, { ...profile, injuries: [] }, { recent: options.recent, ...opts }).length > count;
  const recentSet = new Set(options.recent ?? []);

  return Array.from({ length: profile.days_per_week }, (_, k) => {
    const slot = slotOf?.get(trainingDays[k]!);
    const def = !slotOf ? defs[(cursor + k) % defs.length]! : slot ? defs[shapes.indexOf(slot)]! : defs[(cursor + defs.length - 1) % defs.length]!;
    let wanted = [...def.slots];
    // 중점 부위(D55 ④): 그쪽 패턴을 1개 더 — 하체면 둔근, 상체면 수평 당기기. 그 쪽 슬롯이 있는 날만.
    if (focus === "lower" && wanted.some(([p]) => ["squat", "hinge", "lunge"].includes(p))) wanted.splice(1, 0, ["glute", "lunge"]);
    if (focus === "upper" && wanted.some(([p]) => ["h_push", "h_pull", "v_pull"].includes(p))) wanted.splice(1, 0, ["h_pull", "v_pull"]);
    const target = count + Number(wanted.length > def.slots.length);

    // 템플릿 순서 = 우선순위(종목 수가 모자라면 뒤가 빠진다). 표시 순서는 복합 → 고립이다(아래 정렬).
    const picked: Array<{ pattern: Pattern; candidates: string[] }> = [];
    for (const options_ of wanted) {
      if (picked.length >= target) break;
      // 복근은 주에 한 날에만(D24-1).
      if (options_[0] === "core" && coreUsed) continue;
      // 입문자 바벨은 그 날 첫 슬롯(메인)에서만 고를 수 있다(D55 ①).
      const noBarbell = beginner && picked.length > 0;
      const lists = options_.map((p) => slotCandidates(p, profile, { recent: options.recent, muscles: def.muscles, noBarbell }));
      const at = lists.findIndex((list) => list.length > 0);
      if (at < 0) continue;
      const pattern = options_[at]!;
      // 주 패턴 후보가 1개뿐일 때만 대체 패턴을 뒤에 붙인다(맨몸 힌지 = 굿모닝 1개 → 브릿지). 2개 이상이면
      // 섞지 않는다 — 수직 당기기 슬롯에서 로우를 고르면 주간 패턴 보장이 깨진다(codex N8a R1).
      const candidates = lists[at]!.length >= 2 ? lists[at]! : [...new Set(lists.slice(at).flat())].slice(0, PER_SLOT);
      // 부상으로 후보가 1개만 남은 슬롯은 억지로 채우지 않는다 — 어깨 부상에 남은 플라이 하나로 수평 밀기를 매일 채우던 것
      // (N9 실측). 부상이 없으면 1개여도 둔다 — 덤벨 홈짐의 힌지는 스티프 레그 덤벨 데드리프트 하나다.
      if (candidates.length < 2 && injured && reducedByInjury(options_[at]!, candidates.length, { muscles: def.muscles, noBarbell })) continue;
      // 대체 패턴이 그 날 이미 있거나 뒤 슬롯에 원래 패턴으로 나오면 건너뛴다 — 수직 당기기 대체 로우 + 원래 로우로 로우가
      // 두 번이던 것(N9 실측 · 홈짐·맨몸). 빈 자리는 다음 슬롯이 채운다.
      // 첫 슬롯(메인 자리)에서는 바꾸지 않는다 — 메인이 후면 어깨가 되고 바벨 허용 자리까지 써 버린다(codex N9 R8).
      if (at > 0 && picked.length > 0 && (picked.some((p) => p.pattern === pattern) || wanted.slice(wanted.indexOf(options_) + 1).some(([p]) => p === pattern))) {
        // 그냥 빼면 그 자리를 반대쪽(밀기)이 채워 주간 밀기:당기기가 기운다(codex N9 R7) — 같은 쪽의 다른 패턴으로 바꾼다.
        // 다 없으면 같은 패턴의 다른 운동(기본 운동은 settle 이 겹치지 않게 고른다).
        const swap = (SAME_SIDE[pattern] ?? [pattern])
          .filter((p) => p === pattern || !picked.some((x) => x.pattern === p))
          .map((p) => ({ p, list: slotCandidates(p, profile, { recent: options.recent, muscles: def.muscles, noBarbell }) }))
          .find(({ list }) => list.length > 0);
        if (swap) picked.push({ pattern: swap.p, candidates: swap.list });
        continue;
      }
      picked.push({ pattern, candidates });
      if (pattern === "core") coreUsed = true;
    }
    // 기본 운동(후보 맨 앞) 정하기 — 같은 패턴이 주에 다시 나오면(메인·직전 주 종목 맨 앞 제외) 한 칸씩 돌리고,
    // 같은 날 앞 슬롯의 기본 운동과 겹치면 더 돌린다. 끝내 겹치면 그 슬롯은 뺀다(codex N9 R1 — 맨몸 하체 날).
    const firstsToday = new Set<string>();
    const settled: Array<{ pattern: Pattern; candidates: string[] }> = [];
    const settle = (pattern: Pattern, base: string[], primary: boolean) => {
      const nth = seen.get(pattern) ?? 0;
      let shift = primary || recentSet.has(base[0]!) ? 0 : nth % base.length;
      for (let tries = 0; tries < base.length && firstsToday.has(base[shift]!); tries += 1) shift = (shift + 1) % base.length;
      if (firstsToday.has(base[shift]!)) return false;
      seen.set(pattern, nth + 1);
      const candidates = [...base.slice(shift), ...base.slice(0, shift)];
      firstsToday.add(candidates[0]!);
      settled.push({ pattern, candidates });
      return true;
    };
    const byRole = [...picked].sort((a, b) => Number(COMPOUND.has(b.pattern)) - Number(COMPOUND.has(a.pattern)));
    byRole.forEach(({ pattern, candidates }, i) => settle(pattern, candidates, i === 0 && COMPOUND.has(pattern)));
    // 건너뛴 자리 보충 — 먼저 그 날 아직 없는 패턴으로, 그래도 모자라면 있는 패턴의 다른 운동으로 종목 수를 채운다
    // (codex N9 R1·R2). 복근 하루 제한은 그대로.
    // 반복 보충은 더 채울 수 없을 때까지 돈다 — 패턴마다 한 번만 시도하면 남은 운동이 있어도 모자란다(codex N9 R3).
    for (let pass = 0; settled.length < target; pass += 1) {
      const before = settled.length;
      const allowRepeat = pass > 0;
      for (const pattern of FILLER) {
        if (settled.length >= target) break;
        if ((!allowRepeat && settled.some((p) => p.pattern === pattern)) || (pattern === "core" && coreUsed)) continue;
        if (def.noFill?.includes(pattern)) continue;
        // 부상 판정도 같은 조건(분할 근육·바벨·이미 고른 운동 제외)으로 센다(codex N9 R6).
        const opts = { muscles: def.muscles, noBarbell: beginner && settled.length > 0, exclude: firstsToday };
        const candidates = slotCandidates(pattern, profile, { recent: options.recent, ...opts });
        if (candidates.length === 0 || (candidates.length < 2 && injured && reducedByInjury(pattern, candidates.length, opts))) continue;
        if (settle(pattern, candidates, false) && pattern === "core") coreUsed = true;
      }
      // 반복을 허용한 바퀴에서도 못 채우면 더 채울 운동이 없다.
      if (allowRepeat && settled.length === before) break;
    }
    const ordered = [...settled].sort((a, b) => Number(COMPOUND.has(b.pattern)) - Number(COMPOUND.has(a.pattern)));
    // 각 슬롯 후보에서 같은 날 다른 슬롯의 기본 운동을 뺀다 — LLM 이 남의 기본 운동을 가져가 그 슬롯이 밀려나지 않게
    // (codex N9 R5 · resolveSlotDraft 는 다음 후보로 채우는데 작은 맨몸 목록에선 남는 것이 없었다).
    const defaults = new Set(ordered.map((s) => s.candidates[0]!));
    const slots: Slot[] = ordered.map(({ pattern, candidates: all }, i) => {
      const candidates = [all[0]!, ...all.slice(1).filter((id) => !defaults.has(id))];
      const compound = COMPOUND.has(pattern);
      return {
        key: `d${k}s${i}`,
        pattern,
        role: i === 0 && compound ? "primary" : compound ? "secondary" : "accessory",
        // 입문자에게는 저렙 근력 렙을 주지 않는다(D104 ②). 근력 목표 초중급의 메인만 strength.
        repIntent: i === 0 && compound && strengthGoal && !beginner ? "strength" : "hypertrophy",
        candidates,
      };
    });
    return { label: def.label, slots };
  });
}

/** 골격의 모든 슬롯 후보 — P1 생성의 허용 id(확장·최종 검사가 같은 집합을 본다). */
export function skeletonIds(skeleton: SkeletonDay[]): string[] {
  return [...new Set(skeleton.flatMap((d) => d.slots.flatMap((s) => s.candidates)))];
}

interface RawSlotPick {
  slot?: unknown;
  exercise_id?: unknown;
  reason?: unknown;
  alternatives?: unknown;
}

/**
 * LLM 의 슬롯 드래프트(02-data-model §B1a) → DraftPlan(§B1). 슬롯마다 LLM 이 고른 id 가 **그 슬롯 후보**이고
 * 그 날 아직 안 쓴 것이면 받고, 아니면(후보 밖 · 다른 슬롯 id · 같은 날 중복 · 빠진 슬롯) 그 슬롯의 다음
 * 후보로 채운다 — 재시도로 시간을 쓰지 않는다. 역할·순서·렙 의도는 골격 것이다(INV-1). 이유·메모의 숫자는
 * 지운다(`clean`). `fallbacks` 는 LLM 이 틀린 슬롯 수 — 실측 지표다.
 */
export function resolveSlotDraft(
  raw: unknown,
  skeleton: SkeletonDay[],
  split: string,
  clean: (text: string) => string,
): { draft: Record<string, unknown>; fallbacks: number } {
  const picks = new Map<string, RawSlotPick>();
  const slots = (raw as { slots?: unknown } | null)?.slots;
  for (const pick of Array.isArray(slots) ? (slots as RawSlotPick[]) : []) {
    if (typeof pick?.slot === "string" && !picks.has(pick.slot)) picks.set(pick.slot, pick);
  }
  let fallbacks = 0;
  const week = skeleton.map((day, k) => {
    const used = new Set<string>();
    const items = day.slots.flatMap((slot, i) => {
      const pick = picks.get(slot.key);
      const wanted = typeof pick?.exercise_id === "string" ? pick.exercise_id : undefined;
      const ok = wanted !== undefined && slot.candidates.includes(wanted) && !used.has(wanted);
      const id = ok ? wanted : slot.candidates.find((c) => !used.has(c));
      if (!ok) fallbacks += 1;
      if (id === undefined) return [];
      used.add(id);
      const reason = ok && typeof pick?.reason === "string" ? clean(pick.reason) : "";
      const alternatives = Array.isArray(pick?.alternatives)
        ? (pick.alternatives as unknown[]).filter((a): a is string => typeof a === "string" && a !== id && slot.candidates.includes(a)).slice(0, 2)
        : [];
      return [
        {
          kind: "strength",
          exercise_id: id,
          role: slot.role,
          order: i + 1,
          rep_intent: slot.repIntent,
          ...(reason ? { reason } : {}),
          ...(alternatives.length > 0 ? { alternatives } : {}),
        },
      ];
    });
    return { day_index: k, session_type: "lift", focus: day.label, items };
  });
  const note = (raw as { week_note?: unknown } | null)?.week_note;
  const weekNote = typeof note === "string" ? clean(note) : "";
  return {
    draft: { schema_version: "1.0", split_type: split, week, ...(weekNote ? { week_note: weekNote } : {}) },
    fallbacks,
  };
}
