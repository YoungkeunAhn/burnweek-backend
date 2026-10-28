/**
 * Prompt construction (architecture/03-llm-adapter.md §프롬프트 구조, NFR-COST-1).
 *
 * - systemPrefix = programming rules + DraftPlan schema + safety guards.
 *   Stable across users/weeks → cacheable (prompt caching).
 * - userContext  = variable turn: profile + prior-week *selection signals*,
 *   XML-delimited. Per design.md §3.4 the numeric log (loads, reps, durations,
 *   completion_pct) is withheld from the LLM and given ONLY to the expansion
 *   engine — that is the INV-1 boundary. Free-text notes are withheld too
 *   (they carry pain/medical prose; design.md §6).
 *
 * The model outputs ONLY a DraftPlan (numeric-light). It must NOT emit weights,
 * set counts, rest, or %1RM — code computes those (INV-1).
 */
import { byId } from "../data/exercises";
import { chooseSplit, splitTemplate } from "../data/splits";
import { ALL_DAYS, pickTrainingDays, slotAssignment } from "./expand";
import { allowedGeneratedExerciseIds } from "./exercise-policy";
import type { CompletedDay, GenerateRequest, UserProfile } from "./types";
import type { Pattern, SkeletonDay } from "./slots";

/**
 * 저장된 WeeklyPlan v1 → 편성됐던 종목 id (중복 제거, 편성 순서).
 *
 * 호출 층(Firestore·dev-server)이 직전 주 플랜을 읽어 `recent_exercise_ids` 를
 * 채우는 데 쓴다. 여기 두는 이유는 두 런타임이 **같은 규칙**을 써야 하기
 * 때문이다 — 한쪽만 유산소를 빼면 dev 와 배포본이 다른 플랜을 낳는다.
 *
 * 카탈로그에 없는 id 는 버린다: 이 값은 프롬프트로 들어가므로 저장된 문서가
 * 오염돼도 임의 문자열이 모델에 닿지 않는다.
 */
export function recentExerciseIds(plan: unknown): string[] {
  const week = (plan as { week?: unknown } | null)?.week;
  if (!Array.isArray(week)) return [];
  const out = new Set<string>();
  for (const day of week) {
    const exercises = (day as { exercises?: unknown } | null)?.exercises;
    if (!Array.isArray(exercises)) continue;
    for (const ex of exercises) {
      const id = (ex as { exercise_id?: unknown } | null)?.exercise_id;
      if (typeof id === "string" && byId(id)) out.add(id);
    }
  }
  return [...out];
}

/** Non-numeric per-exercise signal distilled from one PerformedSession v1. */
interface ExerciseSignal {
  exercise_id: string;
  modality: string;
  performed: boolean;
  any_pain: boolean;
  any_failure: boolean;
  cardio_modality?: string;
  cardio_style?: string;
}

interface SessionSignal {
  completion: string; // "completed" | "partial" | "skipped"
  exercises: ExerciseSignal[];
}

// Closed enums from PerformedSession v1 (02-data-model §B3). Anything outside
// these is dropped rather than forwarded: `prior_logs` is `unknown[]` on the
// wire, so a free-text field could otherwise carry prose into the prompt.
const COMPLETION = ["completed", "partial", "skipped"] as const;
const MODALITY = ["strength", "cardio", "bodyweight"] as const;
const CARDIO_MODALITY = ["cycling", "rowing", "elliptical", "incline_walk", "running", "stairs"] as const;
const CARDIO_STYLE = ["LISS", "HIIT"] as const;

function oneOf(value: unknown, allowed: readonly string[]): string | undefined {
  return typeof value === "string" && allowed.includes(value) ? value : undefined;
}

/**
 * PerformedSession v1[] → non-numeric selection signals (INV-1 boundary).
 * Every forwarded value is either a closed-enum member or a slug id; numbers
 * and free text never leave this function. Malformed entries are dropped
 * rather than thrown, so a bad log cannot fail generation.
 *
 * Ids must be catalogue members: an id the catalogue does not know is dropped
 * rather than forwarded, so no client-supplied string can reach the prompt.
 */
/**
 * 이번 주 완료 세션 → 요일·근력 종목 id(D60 ②). `extractSelectionSignals` 와 같은 자리의 닫힌 필터다 —
 * 카탈로그에 있는 id 만, 유산소는 제외(분할 축이 아니다), 수치·메모는 어느 칸에도 없다(INV-1).
 * 근력 종목이 없는 날(유산소만 한 날)은 싣지 않는다 — 분할 슬롯을 차지하지 않는다.
 */
export function completedThisWeek(sessions: unknown): CompletedDay[] {
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return [];
  const out: CompletedDay[] = [];
  for (const [key, raw] of Object.entries(sessions as Record<string, unknown>)) {
    if (!/^[0-6]$/.test(key)) continue;
    const s = raw as { exercises?: unknown } | null;
    const exercises = s && typeof s === "object" && Array.isArray(s.exercises) ? s.exercises : [];
    const ids = new Set<string>();
    for (const exRaw of exercises) {
      const ex = exRaw as Record<string, unknown> | null;
      if (!ex || typeof ex.exercise_id !== "string" || ex.modality === "cardio") continue;
      const known = byId(ex.exercise_id);
      if (known) ids.add(known.id);
    }
    if (ids.size > 0) out.push({ day_index: Number(key), exercise_ids: [...ids] });
  }
  return out.sort((a, b) => a.day_index - b.day_index);
}

export function extractSelectionSignals(priorLogs: unknown[]): SessionSignal[] {
  const out: SessionSignal[] = [];
  for (const raw of priorLogs ?? []) {
    const s = raw as Record<string, unknown> | null;
    if (!s || typeof s !== "object") continue;
    const exercises = Array.isArray(s.exercises) ? s.exercises : [];
    out.push({
      completion: oneOf(s.completion, COMPLETION) ?? "unknown",
      exercises: exercises.flatMap((exRaw) => {
        const ex = exRaw as Record<string, unknown> | null;
        if (!ex || typeof ex.exercise_id !== "string") return [];
        const known = byId(ex.exercise_id);
        if (!known) return [];
        const sets = (Array.isArray(ex.sets) ? ex.sets : []) as Record<string, unknown>[];
        const cardio = sets.map((set) => set?.cardio as Record<string, unknown> | undefined).find(Boolean);
        const cardioModality = oneOf(cardio?.modality, CARDIO_MODALITY);
        const cardioStyle = oneOf(cardio?.style, CARDIO_STYLE);
        return [
          {
            exercise_id: known.id,
            modality: oneOf(ex.modality, MODALITY) ?? "unknown",
            performed: sets.length > 0,
            any_pain: sets.some((set) => set?.pain_flag === true),
            any_failure: sets.some((set) => set?.failed === true),
            ...(cardioModality ? { cardio_modality: cardioModality } : {}),
            ...(cardioStyle ? { cardio_style: cardioStyle } : {}),
          },
        ];
      }),
    });
  }
  return out;
}

/**
 * Remove fields that the expansion engine deliberately ignores before the
 * schema is shown to the model. The committed schema remains the compatibility
 * validator for saved/older drafts; this projection only narrows new output.
 *
 * Cardio is prescribed deterministically by `planCardio`, and the final day
 * label is rebuilt by `focusLabel`. Asking the model to write either one adds
 * output and reasoning without changing WeeklyPlan v1.
 */
export function compactDraftSchema(draftSchema: Record<string, unknown>): Record<string, unknown> {
  const compact = JSON.parse(JSON.stringify(draftSchema)) as Record<string, unknown>;
  const properties = compact.properties as Record<string, unknown>;
  const week = properties.week as Record<string, unknown>;
  const day = week.items as Record<string, unknown>;
  const dayProperties = day.properties as Record<string, unknown>;
  const items = dayProperties.items as Record<string, unknown>;
  const item = items.items as Record<string, unknown>;
  const itemProperties = item.properties as Record<string, unknown>;

  // `focus` is still required by the compatibility schema, but its value is
  // code-owned. An empty constant prevents the model from composing prose.
  dayProperties.focus = {
    type: "string",
    const: "",
    description: "항상 빈 문자열. 최종 요일 제목은 코드가 만든다.",
  };
  dayProperties.session_type = {
    type: "string",
    const: "lift",
    description: "근력 세션만 출력한다. 휴식일과 유산소는 코드가 만든다.",
  };

  // These fields are not read anywhere in resolve/expand. Cardio suggestions
  // are also ignored because the deterministic cardio engine owns them.
  for (const key of ["name", "cardio_kind", "substitution_options", "coaching_cue"]) {
    delete itemProperties[key];
  }
  itemProperties.kind = { type: "string", const: "strength" };

  return compact;
}

export function buildSystemPrefix(draftSchema: Record<string, unknown>): string {
  return [
    "너는 근력·유산소 주간 운동 플랜의 '운동 선택·구성' 전문가다.",
    "역할 경계(절대): 너는 근력 운동 선택·역할·순서만 결정한다.",
    "유산소 종류·스타일과 수치(무게·세트 수·렙 수·휴식·%1RM·지속시간·강도존)는 절대 만들지 마라 — 코드가 계산한다.",
    "출력은 아래 DraftPlan JSON 스키마를 100% 만족하는 JSON 객체 하나뿐이다. 설명·마크다운·코드펜스 금지.",
    "안전: 사용자 부상 부위를 악화시키는 운동을 넣지 마라. 통증 시 중단 원칙을 전제로 구성하라.",
    "exercise_id는 <available_exercise_ids>에 있는 값만 사용하라. 목록에 없는 id는 무시되어 해당 운동이 플랜에서 빠진다.",
    "분할: <split_plan>이 있으면 그것이 **이번 주 요일 구성의 정답**이다. n번째 훈련일에는 그 날에 적힌 부위의 운동만 넣어라.",
    "  거기 적히지 않은 부위를 다른 날에 끼워 넣지 마라 — 검증에서 걸려 플랜이 다시 생성된다.",
    "  복근(abdominals)은 어느 훈련일에든 넣을 수 있지만 **주에 한 요일에만** 넣어라.",
    "연속성: <recent_exercises>가 비어 있지 않으면 그 종목들이 사용자가 지금 하고 있는 운동이다.",
    "  코어 종목(스쿼트·벤치·데드리프트류 등 그 주의 주요 복합운동)은 **그대로 이어가라** — 매주 종목을 갈아엎으면 숙련도가 쌓이지 않는다.",
    "  변화는 보조·고립 운동에서 주고, 통증이 기록된 종목은 예외로 교체하라.",
    "세션 구성(사람이 루틴 짜는 방식 — research/03 §훈련 분할, NSCA 운동 순서):",
    "  1) **순서는 복합 → 고립**이다. order=1 은 그 날 축 부위의 자유중량 복합운동(스쿼트·벤치·데드·로우·오버헤드류),",
    "     그 다음 보조 복합, 마지막이 머신·케이블 고립. 뒤로 갈수록 피로로 수행력이 10–30% 떨어지므로 큰 운동을 먼저 둔다.",
    "     role 도 이 순서와 맞춘다: primary(자유중량 복합) → secondary(보조 복합·머신 복합) → accessory(고립).",
    "  2) **세션당 4–7종목**. 그 날 축이 되는 큰 부위에 2–3종목, 붙는 작은 부위(삼두·이두·복근 등)에 1–2종목을 준다.",
    "     profile.session_len_min 이 30분이면 4 · 45분 5 · 60분 6 · 75분 이상 7종목이다. 이 시간은 웨이트만 센다(유산소는 코드가 따로 붙인다).",
    "  3) **같은 패턴을 한 세션에 반복하지 마라.** 미는 날은 수평(벤치)과 상방(오버헤드)/각도(인클라인)를 섞고,",
    "     당기는 날은 수직 당기기(풀업·랫풀다운)와 수평 당기기(로우)를 둘 다 넣는다. 하체는 무릎 주도(스쿼트·레그프레스)와",
    "     고관절 주도(RDL·힙쓰러스트·레그컬)를 둘 다 넣는다 — 한쪽만 넣으면 그 날 부위 절반이 안 쓰인다.",
    "  4) 축 부위의 복합운동에는 rep_intent=strength 또는 hypertrophy 를, 고립운동에는 hypertrophy(또는 endurance)를 준다.",
    "  5) 훈련일이 그 부위를 한 주에 두 번 도는 경우(예: 주 6일 3분할), 두 번째 날은 첫 날과 **다른 종목·다른 각도**로 짠다.",
    "중점 부위(<focus_area>lower|upper</focus_area> 가 있을 때 — D55 ④): 그쪽 부위에 종목을 **1개 더** 넣어라.",
    "  2분할 하체 중점이면 하체 날 5–6종목·상체 날 4종목, 전신이면 세션마다 중점 쪽 +1. 분할표(<split_plan>)와 그 밖의 규칙은 그대로다 —",
    "  반대쪽 부위를 빼지 마라. 태그가 없거나 balanced 면 종전 그대로.",
    "입문자(<experience_preset>beginner</experience_preset> 가 있을 때 — D55):",
    "  머신·케이블·덤벨 종목을 앞세워라. primary 도 머신·덤벨 복합운동(레그프레스·체스트프레스 머신·덤벨 프레스류)이면 된다.",
    "  바벨 복합운동은 **세션당 1개까지**만 넣어라 — 기술 요구가 높아 입문자는 자세 학습이 먼저다.",
    "  단 <recent_exercises>의 코어 종목은 이 규칙보다 **연속성이 우선**이다 — 이어가던 바벨 종목을 머신으로 갈아엎지 마라.",
    "  이 태그가 없으면(초중급) 위 세션 구성 규칙 그대로다.",
    "맨몸(<environment_preset>bodyweight_only</environment_preset> 가 있을 때):",
    "  목록에 철봉·바벨이 없다. order=1·primary 는 자유중량 대신 **후보 중 다관절 맨몸 운동**(푸시업·스쿼트·런지류)이면 된다.",
    "  당기기는 목록에 있는 로우류(인버티드 로우·도어 로우)로 채운다 — 수직 당기기(풀업·랫풀다운) 규칙은 적용하지 않는다.",
    "목표(goals)는 1–3개다. 여러 개면 **모두** 반영하되 첫 번째를 우선한다:",
    "  build_muscle=근비대(rep_intent 주로 hypertrophy) · gain_strength=근력(핵심 복합운동에 strength)",
    "  lose_fat=유산소 비중↑·전신 순환 · endurance=근지구력(endurance)·심폐",
    "  mobility=가동성/스트레칭 종목을 세션당 1–2개 포함 · general_fitness=전신 균형",
    "출력을 짧게 유지하라. week에는 profile.days_per_week 개의 lift 세션만 넣고 휴식일·유산소 전용일은 출력하지 마라.",
    "focus는 반드시 빈 문자열로 쓰고, 스키마에 없는 name·coaching_cue·substitution_options·cardio_kind는 출력하지 마라.",
    "",
    "<draft_plan_schema>",
    JSON.stringify(draftSchema),
    "</draft_plan_schema>",
  ].join("\n");
}

/**
 * 요일 구성의 정답표. **사용자가 분할을 고른 경우에만** 실린다(D24) — 고르지
 * 않았으면 종전대로 LLM 이 부위 구성을 정하고, 검증도 그에 맞춰 돌지 않는다.
 *
 * 분할 자체는 코드가 정한다(INV-1: 볼륨 분배 방식은 수치·안전 결정이다).
 * 모델에게는 결정된 표를 주고 그 안에서 종목만 고르게 한다.
 */
function splitPlanBlock(profile: UserProfile, completed: CompletedDay[] = []): string[] {
  if (!profile.split_pref) return [];
  const template = splitTemplate(chooseSplit(profile.days_per_week, profile.split_pref));
  if (!template) return [];
  // 완료한 날이 있으면(재생성 · D60 ②) 요일별로 적는다 — 완료한 요일은 검사하지 않고, 남은 요일은
  // 완료한 부위의 다음 슬롯부터 이어간다(`splitCursor` — 검사와 같은 함수라 둘이 안 갈린다).
  if (completed.length > 0) {
    const days = pickTrainingDays(profile.available_days ?? ALL_DAYS, profile.days_per_week);
    const slots = slotAssignment(template, days, completed);
    const byDay = days.map((d) => {
      const day = slots.get(d);
      if (!day) return `${DAY_NAMES_KO[d]}(${d}): 완료한 날 — 검사하지 않는다`;
      return `${DAY_NAMES_KO[d]}(${d}): ${day.label} (${day.muscles.join(", ")})`;
    });
    return [
      '<split_plan note="요일별 부위. 완료한 날 뒤로 분할 순서를 이어간다. 복근은 주 한 요일에만">',
      ...byDay,
      "</split_plan>",
    ];
  }
  const rows = Array.from({ length: profile.days_per_week }, (_, n) => {
    const day = template[n % template.length];
    return `${n + 1}번째 훈련일: ${day.label} (${day.muscles.join(", ")})`;
  });
  return [
    '<split_plan note="훈련일 순서별 부위. n번째 훈련일은 <training_days> 의 n번째 요일이다. 복근은 주 한 요일에만">',
    ...rows,
    "</split_plan>",
  ];
}

const DAY_NAMES_KO = ["월", "화", "수", "목", "금", "토", "일"];

/**
 * 근력 요일은 코드가 정한다(D46) — **모든 프로필**에 싣는다(`split_plan` 은 헬스장 분할에만 있다).
 * 모델이 다른 요일을 내도 `assignTrainingDays` 가 덮어쓰지만, 프롬프트가 요일 재량을 말하면
 * 둘이 서로 다른 요일을 말하게 된다.
 */
function trainingDaysBlock(profile: UserProfile): string[] {
  const days = pickTrainingDays(profile.available_days ?? ALL_DAYS, profile.days_per_week);
  return [
    '<training_days note="근력 세션의 요일은 코드가 정했다. week 의 lift/lift_plus_cardio day_index 는 이 값만 쓴다. 휴식일은 적지 않아도 된다">',
    days.map((d) => `${DAY_NAMES_KO[d]}(${d})`).join(" "),
    "</training_days>",
  ];
}

export function buildUserContext(
  req: GenerateRequest,
  availableExerciseIds = allowedGeneratedExerciseIds(req.profile, req.recent_exercise_ids ?? []),
): string {
  const { profile, prior_logs, week_start_date, recent_exercise_ids } = req;
  const completed = req.completed_this_week ?? [];
  return [
    `<week_start_date>${week_start_date}</week_start_date>`,
    "<profile>",
    JSON.stringify(profile),
    "</profile>",
    // Real catalogue ids, filtered by the user's equipment. Without this the model
    // invents plausible ids (`barbell_rdl`) and the engine has to drop the slot.
    "<available_exercise_ids note=\"exercise_id는 반드시 이 목록에서만 고른다. 목록에 없는 id는 무시된다\">",
    // 직전 주 종목은 컷과 무관하게 남긴다(D55 ⑥) — 연속성 규칙이 성립하려면 목록에 있어야 한다.
    availableExerciseIds.join(" "),
    "</available_exercise_ids>",
    // 입문자 프리셋 신호(D55 ①). enum 한 단어뿐 — 렙·kg 은 코드만 안다(INV-1).
    ...(profile.experience_level === "beginner" ? ["<experience_preset>beginner</experience_preset>"] : []),
    // 맨몸 신호(백로그 운동목록 02 §3 5) — 헬스장 전제 규칙(수직 당기기·자유중량 primary)을 바꾼다.
    ...(profile.environment === "bodyweight_only" ? ["<environment_preset>bodyweight_only</environment_preset>"] : []),
    // 중점 부위(D55 ④) — enum 한 단어. balanced 는 태그 없음과 같으므로 싣지 않는다.
    ...(profile.focus_area === "lower" || profile.focus_area === "upper" ? [`<focus_area>${profile.focus_area}</focus_area>`] : []),
    // 연속성 신호. **수행 로그가 아니라 직전 주 플랜**이라 "짰던 것"이지
    // "한 것"이 아니다 — 로깅이 붙기 전까지의 최선의 프록시다.
    "<recent_exercises note=\"직전 주에 편성된 종목. 사용자가 지금 하고 있는 운동으로 본다. 코어 종목은 이어가라. 없으면 빈 배열\">",
    JSON.stringify(recent_exercise_ids ?? []),
    "</recent_exercises>",
    ...trainingDaysBlock(profile),
    ...splitPlanBlock(profile, completed),
    // 이번 주 완료 세션(D60 ②) — 요일과 종목 id 뿐이다(INV-1). 없으면 블록 자체가 없다 = 종전 프롬프트.
    ...(completed.length > 0
      ? [
          // 「다음날 같은 부위 금지」는 분할을 고른 사용자에게만 말한다(D60 Q5) — 미선택자는 정보만 받는다.
          profile.split_pref
            ? '<completed_this_week note="이번 주에 이미 완료한 세션(요일·근력 종목 id). 그 요일은 저장 때 옛 플랜이 유지되니 검사하지 않는다 — 아무 종목이나 넣어라. 남은 훈련일은 <split_plan> 의 요일별 부위를 따르라 — 완료한 부위 뒤로 순서가 이어져 있다">'
            : '<completed_this_week note="이번 주에 이미 완료한 세션(요일·근력 종목 id). 그 요일은 저장 때 옛 플랜이 유지되니 검사하지 않는다 — 아무 종목이나 넣어라">',
          JSON.stringify(completed),
          "</completed_this_week>",
        ]
      : []),
    "<prior_week_signals note=\"직전 주 선택 신호(비수치). 수행 여부·통증 유무·실패 유무만. 무게·렙·시간은 코드가 소유하므로 주어지지 않는다. 없으면 빈 배열\">",
    JSON.stringify(extractSelectionSignals(prior_logs)),
    "</prior_week_signals>",
  ].join("\n");
}

// ── P1 — 슬롯 채우기(ADR-0025 · D104 ④ · 백로그 운동목록 09 §4) ─────────────────────────

const PATTERN_KO: Record<Pattern, string> = {
  squat: "스쿼트 계열(무릎 주도)",
  hinge: "힌지(고관절 주도)",
  lunge: "한 다리(런지·스플릿)",
  glute: "둔근(힙 스러스트·브릿지)",
  h_push: "수평 밀기(가슴)",
  v_push: "수직 밀기(어깨)",
  h_pull: "수평 당기기(로우)",
  v_pull: "수직 당기기(풀다운·풀업)",
  chest_iso: "가슴 고립",
  lat_raise: "측면 어깨",
  rear_delt: "후면 어깨",
  biceps: "이두",
  triceps: "삼두",
  leg_curl: "햄스트링 고립",
  leg_ext: "대퇴사두 고립",
  calf: "종아리",
  abduction: "외전(엉덩이 옆)",
  core: "복근·코어",
};
const ROLE_KO = { primary: "메인", secondary: "보조", accessory: "고립" } as const;

/**
 * P1 시스템 프롬프트 — 「역할 경계 + 판단 기준 + 출력 형식」만(09 §4.4). 분할·순서·패턴·종목 수·렙·입문자
 * 바벨 제한은 골격(`buildSkeleton`)과 후보 표에 이미 들어 있어 여기서 말하지 않는다. 사용자와 무관해 캐시된다.
 */
export function buildSlotSystemPrefix(schema: Record<string, unknown>): string {
  return [
    "너는 주간 근력 플랜의 '운동 고르기' 전문가다. 코드가 요일·슬롯(움직임 패턴)·순서·세트·렙·무게를 이미 정했다.",
    "역할 경계(절대): 너는 슬롯마다 그 슬롯의 후보 중 운동 하나를 고르고 한 줄 이유를 쓴다. 숫자(세트·횟수·무게·시간·%)는 쓰지 마라 — 코드가 정한다.",
    "규칙: <week_skeleton> 의 **모든 슬롯**에 하나씩 고른다. exercise_id 는 **그 슬롯의 후보 목록 안에서만** 고른다. 같은 날 같은 운동을 두 번 고르지 마라.",
    "후보는 코드가 고른 순위순이다(앞이 기본 운동). 이유가 없으면 앞쪽을 고른다.",
    "판단 기준(09 §4.1):",
    "  1) 목표 조합 — 목표가 여럿이면 첫 목표를 우선하되 나머지도 반영한다.",
    "  2) 사용자 상황 — 부상 부위·환경·경험. 입문자에게는 배우기 쉬운 운동(머신·덤벨)을 고른다.",
    "  3) 이력 — <recent_exercises> 의 운동이 후보에 있으면 메인·보조 슬롯은 이어간다(숙련이 쌓인다). <prior_week_signals> 에 통증이 있던 운동은 피한다.",
    "  4) 다양성과 연속성 — 같은 패턴이 한 주에 여러 번 나오면 날마다 각도·도구를 바꿔도 된다(예: 하루 머신, 하루 덤벨). 메인은 유지한다.",
    "  5) 설명 — reason 은 이 사용자에게 왜 이 운동인지 한국어 한 문장(숫자 없이). alternatives 는 같은 슬롯 후보에서 기구가 없을 때 쓸 대체 0~2개.",
    "출력은 아래 스키마를 100% 만족하는 JSON 객체 하나뿐이다. 설명·마크다운·코드펜스 금지. week_note 는 이번 주 구성을 한 문장으로(숫자 없이).",
    "",
    "<slot_draft_schema>",
    JSON.stringify(schema),
    "</slot_draft_schema>",
  ].join("\n");
}

/** P1 사용자 턴 — 프로필·이력 신호·골격과 슬롯별 후보 표(id | 한글명 | 장비 | 주근육 | 복합/고립 | 난이도). */
export function buildSlotUserContext(req: GenerateRequest, skeleton: SkeletonDay[]): string {
  const table = skeleton.flatMap((day, k) => [
    `d${k} · ${day.label}`,
    ...day.slots.flatMap((slot) => [
      `  ${slot.key} · ${PATTERN_KO[slot.pattern]} · ${ROLE_KO[slot.role]}`,
      ...slot.candidates.map((id) => {
        const e = byId(id)!;
        return `    ${id} | ${e.name_ko} | ${e.equipment} | ${e.primary_muscles.join(",")} | ${e.mechanic === "compound" ? "복합" : "고립"} | ${e.level}`;
      }),
    ]),
  ]);
  return [
    "<profile>",
    JSON.stringify(req.profile),
    "</profile>",
    "<recent_exercises note=\"직전 주에 편성된 종목\">",
    JSON.stringify(req.recent_exercise_ids ?? []),
    "</recent_exercises>",
    "<prior_week_signals note=\"직전 주 선택 신호(비수치) — 수행·통증·실패 여부만\">",
    JSON.stringify(extractSelectionSignals(req.prior_logs)),
    "</prior_week_signals>",
    "<week_skeleton note=\"요일(d)·슬롯(s)·패턴·역할, 그 아래가 그 슬롯의 후보(순위순)\">",
    ...table,
    "</week_skeleton>",
  ].join("\n");
}

const NUMERAL_WORD =
  "(?:한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|스무|스물|서른|마흔|쉰|일|이|삼|사|오|육|칠|팔|구|십|백|천)+";
const UNIT = "(?:세트|회|번|개|kg|킬로그램|킬로|lb|분|초|시간|퍼센트|%|렙|reps?|sets?|일|주|주일|달|개월)";
const DIGIT_UNIT = new RegExp(String.raw`[0-9]+(?:[.,][0-9]+)?\s*` + `${UNIT}?`, "gi");
const WORD_UNIT = new RegExp(NUMERAL_WORD + String.raw`\s*` + UNIT, "g");

/**
 * 이유·메모에서 수치를 지운다(INV-1 — 처방 숫자는 코드만 말한다). 숫자(전각 포함 — NFKC)와 한글 수사(고유어·한자어)
 * + 단위(세트·회·kg·분·일·주 …)를 지운다. 이 문자열은 저장만 하고(D103 ④) 처방에는 쓰이지 않는다 — 플랜의 수치는
 * 구조적으로 코드가 정한다(SlotDraft 에 수치 필드가 없다). 「이번 주」의 「이번」처럼 수사로 읽히는 낱말이 함께
 * 지워질 수 있다(ponytail: 저장 전용이라 감수 — 화면에 보이게 되면 표시 단계에서 다시 본다).
 */
export function stripNumbers(text: string): string {
  return text.normalize("NFKC").replace(DIGIT_UNIT, "").replace(WORD_UNIT, "").replace(/\s{2,}/g, " ").trim();
}
