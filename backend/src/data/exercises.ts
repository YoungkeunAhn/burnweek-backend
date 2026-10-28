/**
 * Exercise catalogue — `yuhonas/free-exercise-db` (public domain), vendored and
 * slimmed by `scripts/build-exercise-db.cjs`. Shape follows ExerciseTemplate in
 * docs/architecture/02-data-model.md (17-value flat muscle taxonomy).
 *
 * Why vendored: generation must be deterministic and must not depend on the
 * network at request time. Why canonical lowercase-slug ids: one id form across
 * plans, logs and prompts — and the MiniMax POC showed the model invents ids
 * like `barbell_back_squat`, so `resolve()` gives those a chance to land on a
 * real exercise instead of being silently accepted (INV-1: only code decides
 * what exists).
 */
import catalogue from "./exercises.json";
import { CAP_GROUPS, type CapGroup } from "./constants";

/** ExerciseTemplate (02-data-model §ExerciseTemplate). */
export interface Exercise {
  id: string;
  name: string;
  /** 한글 이름 — 시드 카탈로그는 전수 보유(D13). `scripts/name-ko-glossary.cjs`가 생성. */
  name_ko: string;
  modality: "strength" | "cardio" | "bodyweight";
  default_metric: "reps" | "duration" | "distance";
  equipment: string;
  category: string;
  mechanic: "compound" | "isolation" | null;
  force: "push" | "pull" | "static" | null;
  level: "beginner" | "intermediate" | "expert";
  primary_muscles: string[];
  secondary_muscles: string[];
  contraindication_tags: string[];
  is_custom: boolean;
  /**
   * 필요한 도구(백로그 운동목록 02 §3 1 enum). `equipment: "body only"` 는 외부 하중이
   * 없다는 뜻이지 철봉·벤치가 없다는 뜻이 아니다. 없으면 도구가 필요 없다.
   */
  requires?: string[];
  /**
   * 맨몸 사용자를 위해 넣은 종목(백로그 운동목록 04 §3). 헬스장(`full_gym`) 후보에는 넣지 않는다 —
   * 넣으면 그룹당 10개 컷에서 덤벨 런지·굿모닝이 밀려난다(실행 그래프 T1-4).
   */
  bodyweight_pool?: boolean;
  /** 태그를 고친 upstream 종목의 옛 값(04 §4). 헬스장 후보는 이 값으로 본다(T1-4). */
  retagged_from?: { equipment: string; category: string };
}

export const EXERCISES = catalogue as Exercise[];

const BY_ID = new Map(EXERCISES.map((e) => [e.id, e]));

/**
 * Every primary muscle the catalogue actually uses (the 17-value taxonomy of
 * docs/architecture/02-data-model.md). Derived, not hand-kept: a hand-written
 * list drifts the moment the catalogue does, and this one gates a query param.
 */
export const PRIMARY_MUSCLES = [...new Set(EXERCISES.flatMap((e) => e.primary_muscles))].sort();

/**
 * Ids with the underscores removed, for `push_ups` → `pushups`. Ambiguous keys are
 * dropped rather than guessed — a wrong exercise is worse than a dropped slot.
 */
const BY_COLLAPSED = (() => {
  const map = new Map<string, Exercise>();
  const clashes = new Set<string>();
  for (const exercise of EXERCISES) {
    const key = exercise.id.replace(/_/g, "");
    if (map.has(key)) clashes.add(key);
    else map.set(key, exercise);
  }
  for (const key of clashes) map.delete(key);
  return map;
})();

/** Same normalisation the build script applies, for untrusted input. */
export function canonicalId(id: string): string {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/**
 * Token comparison key. The live MiniMax run asked for `seated_cable_row` when the
 * catalogue holds `seated_cable_rows`, so plural and singular have to compare
 * equal — otherwise real exercises get dropped from the plan.
 */
function stem(token: string): string {
  if (token.length > 3 && token.endsWith("es")) return token.slice(0, -2);
  if (token.length > 2 && token.endsWith("s")) return token.slice(0, -1);
  return token;
}

function stemmedTokens(id: string): string[] {
  return id.split("_").filter(Boolean).map(stem);
}

/** Exact catalogue lookup. */
export function byId(id: string): Exercise | undefined {
  return BY_ID.get(id);
}

/**
 * Resolve a possibly model-invented id to a real catalogue entry.
 * Exact canonical match first; otherwise the single catalogue entry whose every
 * token appears in the request (`barbell_back_squat` → `barbell_squat`). The
 * match must be *uniquely* the longest — a tie resolves to `undefined` rather
 * than picking alphabetically, which is how `barbell_romanian_deadlift` used to
 * land on `barbell_deadlift` instead of `romanian_deadlift`.
 *
 * Known ceiling: a qualifier absent from the catalogue is still dropped
 * (`incline_dumbbell_curl` → `dumbbell_curl`). Upgrade path if that starts
 * mattering: an explicit alias table, not a smarter score.
 */
export function resolve(rawId: string): Exercise | undefined {
  const id = canonicalId(rawId);
  const exact = BY_ID.get(id);
  if (exact) return exact;

  // The golden run showed `push_ups` asked for the catalogue's `pushups`, so
  // word-boundary differences are tried before token matching.
  const collapsed = BY_COLLAPSED.get(id.replace(/_/g, ""));
  if (collapsed) return collapsed;

  // Two passes: exact tokens first, then stemmed. Stemming alone would tie
  // `squat_with_bands` against `squats_with_bands` and drop both.
  return matchByTokens(id, false) ?? matchByTokens(id, true);
}

function matchByTokens(id: string, stemmed: boolean): Exercise | undefined {
  const split = (value: string) =>
    stemmed ? stemmedTokens(value) : value.split("_").filter(Boolean);
  const tokens = new Set(split(id));
  if (tokens.size === 0) return undefined;

  let best: Exercise | undefined;
  let bestLength = 0;
  let tied = false;
  for (const exercise of EXERCISES) {
    const candidate = split(exercise.id);
    // Every candidate token must be present in the request, so `barbell_squat`
    // matches `barbell_back_squat` but bare `squat` does not pull in variants.
    if (!candidate.every((t) => tokens.has(t))) continue;
    if (candidate.length > bestLength) {
      best = exercise;
      bestLength = candidate.length;
      tied = false;
    } else if (candidate.length === bestLength) {
      tied = true;
    }
  }
  return tied ? undefined : best;
}

/**
 * Muscle (17-value taxonomy) → volume cap group (design §3.2.1, roll-up table).
 * `abductors`→glutes and `traps`/`lower back`→back are roll-ups: charging them
 * to a neighbouring group makes the ceiling *more* conservative than leaving
 * them uncapped. Documented in design §3.2.1 so code and spec agree.
 * Muscles absent from this map carry no weekly ceiling (abs, forearms, neck,
 * adductors) — design §3.2.1 lists caps for nine groups only.
 */
const MUSCLE_TO_CAP_GROUP: Record<string, CapGroup> = {
  chest: "chest",
  lats: "back",
  "middle back": "back",
  "lower back": "back",
  traps: "back",
  quadriceps: "quads",
  hamstrings: "hamstrings",
  glutes: "glutes",
  abductors: "glutes",
  shoulders: "shoulders",
  biceps: "biceps",
  triceps: "triceps",
  calves: "calves",
};

export function capGroupOf(muscle: string): CapGroup | undefined {
  return MUSCLE_TO_CAP_GROUP[muscle];
}

/** Cap groups this exercise charges volume to (primary muscles only). */
export function capGroupsOf(exercise: Exercise): CapGroup[] {
  return [...new Set(exercise.primary_muscles.map(capGroupOf).filter((g): g is CapGroup => !!g))];
}

/**
 * Contraindication tags = every muscle the exercise loads (a data field on
 * ExerciseTemplate, produced by the build script).
 * The onboarding *injury region* option list is still an open product decision
 * (PRD §13; gate G1 in docs/guides/execution-graph.md), so we deliberately do
 * NOT invent a joint model here — node B4 excludes by muscle set, and the
 * region→muscle table lands once the onboarding options are fixed.
 */
export function contraindicationTags(exercise: Exercise): string[] {
  return exercise.contraindication_tags;
}

export interface ExerciseFilter {
  modality?: Exercise["modality"];
  /** Any primary muscle in this list. */
  primaryMuscles?: string[];
  /** Only exercises whose equipment the user owns. */
  equipment?: string[];
  mechanic?: Exercise["mechanic"];
  /** Drop exercises loading any of these muscles (injury contraindication). */
  excludeMuscles?: string[];
  /** 보유 도구 — `requires` 가 전부 여기 있어야 한다. 없으면 도구 제한 없음. */
  tools?: string[];
  /** 장비 판정 기준 환경 — `full_gym` 은 태그 정정 전 장비값으로 본다(`equipmentFor`). */
  environment?: string;
}

export function find(filter: ExerciseFilter): Exercise[] {
  const excluded = new Set(filter.excludeMuscles ?? []);
  const owned = filter.equipment ? new Set(filter.equipment) : undefined;
  const wanted = filter.primaryMuscles ? new Set(filter.primaryMuscles) : undefined;
  const tools = filter.tools ? new Set(filter.tools) : undefined;

  return EXERCISES.filter((e) => {
    if (filter.modality && e.modality !== filter.modality) return false;
    if (filter.mechanic && e.mechanic !== filter.mechanic) return false;
    if (wanted && !e.primary_muscles.some((m) => wanted.has(m))) return false;
    if (owned && !owned.has(equipmentFor(e, filter))) return false;
    if (!allowedByTools(e, tools)) return false;
    if (excluded.size > 0 && contraindicationTags(e).some((m) => excluded.has(m))) return false;
    return true;
  });
}

/** Sanity guard for the vendored data — run by the catalogue test. */
export function catalogueInvariants(): string[] {
  const problems: string[] = [];
  if (EXERCISES.length === 0) problems.push("catalogue is empty");
  if (BY_ID.size !== EXERCISES.length) problems.push("duplicate ids");
  for (const group of CAP_GROUPS) {
    if (!Object.values(MUSCLE_TO_CAP_GROUP).includes(group)) {
      problems.push(`cap group ${group} has no muscle mapped to it`);
    }
  }
  return problems;
}

/**
 * Candidate ids to put in front of the LLM. The live run showed the model
 * inventing plausible-but-absent ids (`barbell_rdl`, `cable_lat_pulldown`), which
 * `resolve()` then had to drop — so the prompt now offers the real list.
 *
 * Equipment comes from the profile, and `bodyweight_only` is honoured explicitly:
 * offering barbell lifts to someone training at home would produce a plan they
 * cannot perform. Ids only, never numbers, so the INV-1 boundary is untouched.
 */
export function candidateIdsFor(
  profile: { equipment: string[]; environment?: string; experience_level?: string },
  perGroup = 10,
  keepIds: readonly string[] = [],
): string[] {
  const beginner = profile.experience_level === "beginner";
  const { usable, byId, passesEquipment } = generationPool(profile);

  // Balanced by muscle group, not alphabetical: a truncated A–Z list left the
  // model without a bench press or a row, so it invented ids instead.
  const chosen = new Set<string>();
  const byGroup = new Map<string, Exercise[]>();
  for (const exercise of usable) {
    for (const group of capGroupsOf(exercise)) {
      const list = byGroup.get(group) ?? [];
      list.push(exercise);
      byGroup.set(group, list);
    }
  }
  // 그룹 안 선정은 경험 무관하게 복합 → 초급 → id 다. 입문자라고 여기서 장비를 앞세우면
  // 그룹당 10개가 머신으로 차서 바벨 복합이 목록에서 통째로 사라진다 — D55 ① 은
  // 「바벨 복합은 세션당 1개까지」라 LLM 이 고를 바벨이 남아 있어야 한다. 장비 우선은
  // **최종 정렬**에서만 건다(아래).
  for (const group of CAP_GROUPS) {
    const list = (byGroup.get(group) ?? []).sort((a, b) => {
      const byMechanic = Number(b.mechanic === "compound") - Number(a.mechanic === "compound");
      if (byMechanic !== 0) return byMechanic;
      const byLevel = Number(a.level !== "beginner") - Number(b.level !== "beginner");
      return byLevel !== 0 ? byLevel : a.id.localeCompare(b.id);
    });
    for (const exercise of list.slice(0, perGroup)) chosen.add(exercise.id);
  }
  // A few core-trunk options too; they carry no cap group of their own.
  const abs = usable
    .filter((exercise) => exercise.primary_muscles.includes("abdominals"))
    .sort((a, b) => a.id.localeCompare(b.id))
    .slice(0, 5);
  for (const exercise of abs) chosen.add(exercise.id);

  // 연속성(D55 ⑥): 직전 주 종목은 그룹당 컷·프리셋과 무관하게 남긴다 — 프롬프트의
  // 「코어 종목은 이어가라」가 「목록 밖 id 는 버린다」·「입문자는 expert 제외」와
  // 모순되지 않게. 장비·분류 필터는 통과해야 한다(맨몸 사용자에게 바벨을 되돌려
  // 주지 않는다).
  for (const id of keepIds) {
    const exercise = byId.get(id);
    if (exercise && passesEquipment(exercise)) chosen.add(exercise.id);
  }

  // 초중급은 종전 그대로 id 순(바이트 동일). 입문자는 머신·케이블·덤벨을 앞에 둔다
  // (D55 ① — Haugen 2023: 비대 차이 없음, 기술 요구가 낮다). 그룹 안 비교 키만
  // 바꾸고 여기서 id 순으로 돌리면 프롬프트 목록에서 바벨이 도로 앞에 선다(040 §1 ②).
  if (!beginner) return [...chosen].sort();
  const rank = (id: string) => BEGINNER_EQUIPMENT_RANK[byId.get(id)!.equipment] ?? 9;
  return [...chosen].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 생성 후보의 바탕 — 장비·도구·분류·입문자 프리셋을 통과한 종목(헬스장은 옛 태그로 본 값).
 * `candidateIdsFor`(P0 목록)와 슬롯 후보(P1 `slots.ts`)가 같은 규칙을 쓴다.
 */
export function generationPool(profile: { equipment: string[]; environment?: string; experience_level?: string }): {
  usable: Exercise[];
  byId: Map<string, Exercise>;
  passesEquipment: (exercise: Exercise) => boolean;
} {
  const allowed = allowedEquipment(profile);
  const tools = ownedTools(profile);
  const beginner = profile.experience_level === "beginner";
  const passesEquipment = (exercise: Exercise) => {
    if (exercise.modality === "cardio") return false;
    if (exercise.category === "stretching") return false;
    if (!allowedByTools(exercise, tools)) return false;
    // 헬스장은 N1 이전 후보 그대로(T1-4): 새 맨몸 종목은 빼고, 태그만 고친 upstream 종목은
    // 옛 장비값 `other` 가 통과하던 경우(장비 제한 없음 · `other` 보유)에만 남긴다.
    return allowed === undefined || allowed.has(exercise.equipment);
  };
  // 입문자 프리셋(D55 ①): expert 종목과 `other`(스트롱맨·플라이오 기구 — 040 그래프
  // §1 「other 장비의 정체」)는 입문자에게 권하지 않는다. 초중급 목록은 그대로다.
  const matches = (exercise: Exercise) =>
    passesEquipment(exercise) && !(beginner && (exercise.level === "expert" || exercise.equipment === "other"));

  // 헬스장은 N1 이전 후보 그대로다(실행 그래프 T1-4): 맨몸용 새 종목은 빼고, 태그를 고친 종목은
  // 옛 태그(`retagged_from`)로 본다. 그룹당 10개 컷이라 종목 하나만 늘어도 덤벨 스쿼트가 밀려난다.
  const gym = profile.environment === "full_gym";
  const pool = gym ? EXERCISES.filter((e) => !(e.bodyweight_pool && e.is_custom)).map((e) => gymView(e)) : EXERCISES;
  const byId = gym ? new Map(pool.map((e) => [e.id, e])) : BY_ID;
  let usable = pool.filter(matches);
  if (usable.length === 0) {
    // Nothing matched (an unknown equipment string, say). Bodyweight work is
    // always possible, and an empty list would send the model back to inventing.
    usable = pool.filter((exercise) =>
      exercise.equipment === "body only" && allowedByTools(exercise, tools) && !(beginner && exercise.level === "expert"));
  }
  return { usable, byId, passesEquipment };
}

/** 입문자 후보 정렬용 장비 순위 — 낮을수록 앞. 바벨은 뒤로, 그 밖(밴드·볼)은 맨 뒤. */
export const BEGINNER_EQUIPMENT_RANK: Record<string, number> = {
  machine: 0,
  cable: 1,
  dumbbell: 2,
  "body only": 3,
  kettlebells: 4,
  "e-z curl bar": 5,
  barbell: 6,
};

/**
 * Equipment the profile can actually use, or `undefined` for "no filter".
 * The concrete environment→equipment presets are still an open onboarding
 * decision (004 spec §7), so only the unambiguous case is encoded here:
 * `bodyweight_only` means body-only equipment, whatever `equipment[]` says.
 *
 * Exported because the edit path narrows candidates too (`edit.ts`
 * `candidatesFor`). It used to spell the rule out a second time and missed the
 * `bodyweight_only` case, so the picker offered kettlebells to someone who
 * told us they own nothing.
 */
export function allowedEquipment(profile: { equipment: string[]; environment?: string }): Set<string> | undefined {
  if (profile.environment === "bodyweight_only") return new Set(["body only"]);
  return profile.equipment.length > 0 ? new Set(profile.equipment) : undefined;
}

/**
 * 보유 도구, 또는 `undefined`(제한 없음). 맨몸 환경만 건다 — 헬스장엔 철봉·벤치가 있다.
 * 「가진 도구」 칩이 정해지기 전에는 맨몸 `equipment` 가 빈 배열이라 `requires` 가 있는
 * 종목은 전부 빠진다(실행 그래프 G0 Q1 A · 백로그 02 §4 「도구를 선택하지 않으면 0개」).
 */
export function ownedTools(profile: { equipment: string[]; environment?: string }): Set<string> | undefined {
  return profile.environment === "bodyweight_only" ? new Set(profile.equipment) : undefined;
}

export function allowedByTools(exercise: Exercise, owned: ReadonlySet<string> | undefined): boolean {
  return owned === undefined || (exercise.requires ?? []).every((tool) => owned.has(tool));
}

/** `find` 에 넘길 장비·도구 좁히기 — 생성·편집·부상 대체가 같은 규칙을 쓴다. */
export function profileFilter(profile: { equipment: string[]; environment?: string }): Pick<ExerciseFilter, "equipment" | "tools" | "environment"> {
  const equipment = allowedEquipment(profile);
  const tools = ownedTools(profile);
  return {
    ...(profile.environment ? { environment: profile.environment } : {}),
    ...(equipment ? { equipment: [...equipment] } : {}),
    ...(tools ? { tools: [...tools] } : {}),
  };
}

function gymView(exercise: Exercise): Exercise {
  return exercise.retagged_from ? { ...exercise, ...exercise.retagged_from } : exercise;
}

/**
 * 장비 판정에 쓰는 값 — `full_gym` 은 태그 정정 전 값이다. 후보(`candidateIdsFor`)와 생성 검증
 * (`resolveDraft`·`generatedPlanExerciseProblems`)이 같은 값을 봐야 후보로 준 종목을 검증이 거절하지 않는다.
 */
export function equipmentFor(exercise: Exercise, profile: { environment?: string }): string {
  return profile.environment === "full_gym" ? gymView(exercise).equipment : exercise.equipment;
}
