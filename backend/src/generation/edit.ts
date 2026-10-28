/**
 * 플랜 증분 편집(백로그 016). 사용자가 종목을 빼거나 바꾸거나 더하고, 세트 수·무게를 정한다.
 *
 * **고치는 대상은 플랜이 아니라 드래프트다.** 클라이언트가 편집된 `WeeklyPlan` 을
 * 통째로 올리면 세트 수·무게를 지어낼 수 있고, 그건 INV-1(수치·안전은 코드 소유)
 * 위반이다. 그래서 여기서 받는 것은 **op 하나**뿐이고, 서버가 드래프트를 고쳐
 * `expandDraftToWeeklyPlan` 을 다시 돌린다 — 볼륨 상한·금기 필터·부하 계산이
 * 기존 파이프라인 그대로 다시 걸린다. 새 수치 로직은 한 줄도 없다.
 *
 * 재확장은 결정적이다(LLM 없음). 같은 드래프트·프로필이면 같은 플랜이 나오므로
 * "한 줄 고쳤는데 다른 날이 통째로 바뀐다"는 일은 없다 — 다만 주간 볼륨 상한은
 * 주 단위라, 종목을 더하면 상한 재배분이 일어날 수 있고 그건 경고로 보고된다.
 */
import { contraindicatedMuscles } from "./contraindications";
import { CARDIO_EXERCISES, cardioRangeProblems, keepForForm, parseCardioOverride, parseCardioTarget, type CardioTarget } from "./cardio";
import { expandDraftToWeeklyPlan } from "./expand";
import { MEDICAL_DISCLAIMER } from "./safety";
import { checkWeeklyPlan } from "../schemas/validate";
import { find, profileFilter, resolve, PRIMARY_MUSCLES, type Exercise } from "../data/exercises";
import { createExerciseMatcher } from "../data/exercise-search";
import { validateProfile } from "./validate-profile";
import type { UserProfile } from "./types";
import { recentPriorLogs } from "./prior-history";

export type PlanEdit =
  | { op: "remove"; day_index: number; exercise_id: string }
  | { op: "replace"; day_index: number; exercise_id: string; to_exercise_id: string }
  | { op: "add"; day_index: number; to_exercise_id: string }
  /** 세트 수·무게를 사용자가 정한다(백로그 016 §5 선택지 3). `null` 은 코드 값으로 되돌린다. */
  | { op: "tune"; day_index: number; exercise_id: string; sets?: number | null; load_kg?: number | null }
  /** 결정된 하루를 다른 요일로 옮긴다(백로그 018 · [D22-4]). 종목이 아니라 **날**이 대상이다. */
  | { op: "move"; day_index: number; to_day_index: number; mode: "swap" | "merge" }
  /** 렙 범위 의도(백로그 016 §6.5 5). **범위만 고른다 — 실제 수치는 코드가 정한다**(INV-1). */
  | { op: "retarget"; day_index: number; exercise_id: string; rep_intent: RepIntent }
  /** 유산소 목표(041 N4 · [D57] A1·A9 · G0 Q1). 방식·분·운동별 칸을 사용자가 정한다 — **범위 말고는 막지 않는다**(A11). */
  | { op: "cardio"; day_index: number; exercise_id: string; cardio: CardioTarget }
  /** 하루를 비운다(백로그 061 · [D76]) — 그 날 종목 전부 + 유산소 결정 「뺐다」. 결과는 휴식일. 기록은 건드리지 않는다. */
  | { op: "clear_day"; day_index: number }
  /** 그 날 서킷 묶음을 뺀다(N7a · D101 ④) — 유산소 결정 「뺐다」로 남는다(서킷은 유산소 자리다). 근력은 그대로. */
  | { op: "remove_circuit"; day_index: number }
  /** 빈 주를 만든다(백로그 016 §6.5 7 · [D20-2]). **LLM 없이 플랜이 생기는 경로다.** */
  | { op: "blank"; profile: unknown };

/** 드래프트에서 근력 항목이 살아남는 세션 종류(`expand.ts` LIFT_SESSIONS 와 같다). */
const LIFT_SESSION = "lift";

/**
 * 렙 범위 의도. **드래프트 스키마의 enum 과 같아야 한다**(`draft-plan.schema.json`)
 * — 여기서만 늘리면 재확장이 모르는 값을 받아 기본값으로 조용히 되돌린다.
 */
const REP_INTENTS = ["strength", "hypertrophy", "endurance"] as const;
export type RepIntent = (typeof REP_INTENTS)[number];

/**
 * **저장된 드래프트는 `DraftPlan v1` 의 상위집합이다.** `sets_override`·
 * `load_kg_override`·`user_pick` 은 사용자 편집이 남기는 필드로, 스키마
 * (`schemas/draft-plan.schema.json`, `additionalProperties: false`)에는 **일부러
 * 없다** — 그 스키마는 `buildSystemPrefix` 로 **LLM 프롬프트에 실리므로**, 여기에
 * 수치 필드를 넣는 순간 모델이 수치를 채울 통로가 된다(INV-1 위반). 스키마는
 * *LLM 출력*의 계약이고, 저장 드래프트는 거기에 사용자 필드가 더 붙은 것이다.
 * `checkDraftPlan` 은 LLM 출력에만 걸리므로 이 상위집합은 검증을 깨지 않는다.
 */
interface DraftItem {
  kind?: unknown;
  exercise_id?: unknown;
  order?: unknown;
  role?: unknown;
  rep_intent?: unknown;
  user_pick?: boolean;
  sets_override?: unknown;
  load_kg_override?: unknown;
  /** P1 이 남긴 이유·대체 운동(02-data-model §B1a) — 그 종목에 대한 값이다. */
  reason?: unknown;
  alternatives?: unknown;
}
interface DraftDay {
  day_index?: unknown;
  session_type?: unknown;
  focus?: unknown;
  items?: unknown;
  /** 사용자가 그 요일 유산소에 내린 결정(`cardio.ts` `CardioOverride`). 스키마 밖 필드 — 위 주석과 같은 이유. */
  cardio_override?: unknown;
  /** 그 요일에 고정한 서킷 템플릿(N7a · expand 가 남긴다). */
  circuit_template?: unknown;
}

/** 본문이 사용자 입력이므로 모양을 여기서 끝까지 확인한다(신뢰 경계). */
export function parseEdit(body: unknown): PlanEdit | { error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== "object") return { error: "요청 본문이 올바르지 않습니다." };

  // **주 단위 op 는 요일을 받지 않는다** — day_index 검사보다 앞에 둔다.
  // 「편집 되돌리기」(`reset`)는 없앴다(D59) — 알 수 없는 op 와 같이 400 이다.
  if (b.op === "blank") return { op: "blank", profile: b.profile };

  const day = b.day_index;
  if (typeof day !== "number" || !Number.isInteger(day) || day < 0 || day > 6) {
    return { error: "day_index 는 0–6 정수여야 합니다." };
  }
  const from = typeof b.exercise_id === "string" ? b.exercise_id : "";
  const to = typeof b.to_exercise_id === "string" ? b.to_exercise_id : "";

  switch (b.op) {
    case "clear_day":
      return { op: "clear_day", day_index: day };
    case "remove_circuit":
      return { op: "remove_circuit", day_index: day };
    case "remove":
      if (!from) return { error: "exercise_id 가 필요합니다." };
      return { op: "remove", day_index: day, exercise_id: from };
    case "replace":
      if (!from || !to) return { error: "exercise_id 와 to_exercise_id 가 필요합니다." };
      return { op: "replace", day_index: day, exercise_id: from, to_exercise_id: to };
    case "add":
      if (!to) return { error: "to_exercise_id 가 필요합니다." };
      return { op: "add", day_index: day, to_exercise_id: to };
    case "tune": {
      if (!from) return { error: "exercise_id 가 필요합니다." };
      // 세트 수 상한 10 은 플랜 규칙과 같다(`plan-rules.ts` MAX_SETS_PER_EXERCISE) —
      // 여기서 막지 않으면 확장 뒤 영문 진단으로 거절돼 이유가 안 보인다.
      const sets = b.sets;
      if (sets !== undefined && sets !== null && (typeof sets !== "number" || !Number.isInteger(sets) || sets < 1 || sets > 10)) {
        return { error: "세트 수는 1–10 이어야 합니다." };
      }
      const load = b.load_kg;
      if (load !== undefined && load !== null && (typeof load !== "number" || !Number.isFinite(load) || load < 0 || load > 500)) {
        return { error: "무게는 0–500kg 이어야 합니다." };
      }
      if (sets === undefined && load === undefined) return { error: "sets 나 load_kg 중 하나는 필요합니다." };
      return {
        op: "tune",
        day_index: day,
        exercise_id: from,
        ...(sets === undefined ? {} : { sets: sets as number | null }),
        // 0.5kg 단위로 맞춘다 — 원판 단위이고, 그래야 화면에 82.33333 이 안 나온다.
        ...(load === undefined ? {} : { load_kg: load === null ? null : Math.round((load as number) * 2) / 2 }),
      };
    }
    case "move": {
      const toDay = b.to_day_index;
      if (typeof toDay !== "number" || !Number.isInteger(toDay) || toDay < 0 || toDay > 6) {
        return { error: "to_day_index 는 0–6 정수여야 합니다." };
      }
      if (toDay === day) return { error: "같은 요일로는 옮길 수 없습니다." };
      // 기본은 `swap` 이다 — 대상이 비어 있으면 둘이 같은 결과라 클라이언트가
      // 묻지 않아도 되고(계약 §2.2), 덮어쓰기는 어느 쪽에도 없다(D22-4).
      const mode = b.mode === undefined ? "swap" : b.mode;
      if (mode !== "swap" && mode !== "merge") return { error: "mode 는 swap 또는 merge 여야 합니다." };
      return { op: "move", day_index: day, to_day_index: toDay, mode };
    }
    case "retarget": {
      if (!from) return { error: "exercise_id 가 필요합니다." };
      const intent = b.rep_intent;
      if (typeof intent !== "string" || !(REP_INTENTS as readonly string[]).includes(intent)) {
        return { error: `rep_intent 는 ${REP_INTENTS.join("·")} 중 하나여야 합니다.` };
      }
      return { op: "retarget", day_index: day, exercise_id: from, rep_intent: intent as RepIntent };
    }
    case "cardio": {
      if (!from) return { error: "exercise_id 가 필요합니다." };
      if (!CARDIO_EXERCISES[from]) return { error: `고를 수 없는 유산소입니다: ${from}` };
      // 신뢰 경계 — 모양이 틀린 칸을 조용히 버리지 않고 거절한다(`parseCardioTarget` 은 버린다).
      const raw = b.cardio as Record<string, unknown> | null;
      const cardio = parseCardioTarget(raw);
      const notNumber = (o: Record<string, unknown>, k: string) => o[k] !== undefined && o[k] !== null && (typeof o[k] !== "number" || !Number.isFinite(o[k]));
      if (!cardio) return { error: "cardio 에는 style(LISS·HIIT)과 duration_min 이 필요합니다." };
      // 계획 목표는 분 단위다([D77] — 초는 기록 §2.4 에만). 조용히 버리면 클라이언트가 초를 보낸 줄 안다.
      if (raw!.duration_sec !== undefined) return { error: "총 시간(초) 칸은 기록에만 있습니다 — 계획 목표는 분 단위입니다." };
      // **구간 안쪽도 본다**(codex N4 R1). 길이만 세면 `{sec:60, level:"8"}` 은 `level` 만 조용히 빠진 채 통과한다.
      const badSegment = (raw_: unknown) => {
        const s = raw_ as Record<string, unknown> | null;
        if (!s || typeof s !== "object") return true;
        return ["sec", "speed_kmh", "incline_pct", "level"].some((k) => notNumber(s, k))
          || (s.label !== undefined && typeof s.label !== "string");
      };
      if (["distance_m", "incline_pct", "level"].some((k) => notNumber(raw!, k))
        || (raw!.segments !== undefined && (!Array.isArray(raw!.segments) || raw!.segments.length !== cardio.segments?.length || raw!.segments.some(badSegment)))) {
        return { error: "cardio 의 칸 모양이 올바르지 않습니다." };
      }
      const problems = cardioRangeProblems(from, cardio);
      if (problems.length > 0) return { error: problems[0]! };
      return { op: "cardio", day_index: day, exercise_id: from, cardio };
    }
    default:
      return { error: "op 은 add·replace·remove·tune·move·retarget·cardio·clear_day·remove_circuit·blank 중 하나여야 합니다." };
  }
}

/**
 * 편집을 드래프트에 적용한 **새 드래프트**를 돌려준다. 원본은 건드리지 않는다 —
 * 확장이 실패하면(볼륨 상한 위반 등) 저장하지 않고 원본을 그대로 두어야 한다.
 */
// `blank` 는 드래프트를 고치는 게 아니라 새로 만드는 것이라 여기 오지 않는다
// (`editSavedWeek` 이 처리한다). 타입으로 못 오게 막는다.
export function applyEdit(
  draft: unknown,
  edit: Exclude<PlanEdit, { op: "blank" }>,
  /** 저장된 플랜 — 유산소 줄은 드래프트에 없어 그 요일에 지금 무엇이 있는지는 여기서만 안다. */
  plan?: unknown,
): { draft: unknown; swapped?: boolean } | { error: string } {
  const root = draft as { week?: unknown } | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.week)) {
    return { error: "이 플랜은 편집 정보를 갖고 있지 않습니다." };
  }

  // 카탈로그에 없는 id 는 확장 단계에서 조용히 빠진다 — 사용자에게는 "추가했는데
  // 없어졌다"로 보이므로 여기서 막는다. `resolve` 는 생성 경로와 같은 함수라
  // 표기 흔들림(`push_ups`→`pushups`)도 같은 방식으로 흡수한다.
  let target: Exercise | undefined;
  if (edit.op === "replace" || edit.op === "add") {
    target = resolve(edit.to_exercise_id);
    if (!target) return { error: `카탈로그에 없는 운동입니다: ${edit.to_exercise_id}` };
  }

  const week: DraftDay[] = root.week.map((d) => ({ ...(d as DraftDay) }));
  // 근력 없는 날의 유산소는 D45 ① 이전 확장기가 도스로 놓은 것이다(백로그 079) — 지금 확장기는 휴식일에 놓지 않으므로
  // 결정으로 고정하지 않으면 이 편집의 재확장에서 사라지고, `move` 로도 옮겨지지 않는다(드래프트에 옮길 것이 없다).
  pinRestDayCardio(week, plan);

  // 하루 비우기([D76]) — 종목을 하나씩 `remove` 하는 것과 같은 결과를 한 번에. 유산소는 「뺐다」로 남겨
  // 도스 배치가 되살아나지 않게 한다(`blankDraft` 의 하루와 같은 모양). 이미 휴식일이면 그대로(멱등).
  if (edit.op === "clear_day") {
    const day = cardioDay(week, edit.day_index, false);
    day.items = [];
    day.session_type = "rest";
    day.cardio_override = "none";
    return { draft: { ...(root as object), week } };
  }

  // 서킷 빼기 — 서킷은 유산소 자리라 그 요일 유산소 결정 「뺐다」가 곧 서킷 없음이다(재확장이 서킷을 안 낸다).
  if (edit.op === "remove_circuit") {
    const days = (plan as { week?: Array<{ day_index?: unknown; exercises?: Array<{ circuit?: unknown }> }> } | undefined)?.week ?? [];
    const has = days.some((d) => d.day_index === edit.day_index && (d.exercises ?? []).some((e) => e.circuit !== undefined));
    if (!has) return { error: "그 요일에 서킷이 없습니다." };
    cardioDay(week, edit.day_index, false).cardio_override = "none";
    return { draft: { ...(root as object), week } };
  }

  // 요일 이동은 **종목이 아니라 날**이 대상이라 아래 항목 로직을 타지 않는다.
  if (edit.op === "move") return moveDay(root, week, edit);

  // 유산소 목표(041 N4) — 그 요일에 그 유산소 줄이 있어야 한다. 목표는 요일 결정(`cardio_override`)에 남는다.
  if (edit.op === "cardio") {
    if (cardioIdOn(plan, edit.day_index) !== edit.exercise_id) return { error: `그 요일에 ${edit.exercise_id} 가 없습니다.` };
    cardioDay(week, edit.day_index, true).cardio_override = { exercise_id: edit.exercise_id, target: edit.cardio };
    return { draft: { ...(root as object), week } };
  }

  // **유산소 줄은 드래프트 항목이 아니다** — 재확장 때 `planCardio` 가 도스로 놓는다. 그래서
  // 사용자 결정은 그 요일의 `cardio_override` 로 남기고 확장이 마지막에 덮는다(백로그 030 §1.1).
  const fromCardio = (edit.op === "replace" || edit.op === "remove") && resolve(edit.exercise_id)?.modality === "cardio";
  const toCardio = target?.modality === "cardio";
  if (fromCardio || toCardio) {
    // 근력 ↔ 유산소 교체는 **빼고 넣기**다 — 한쪽은 드래프트 항목, 한쪽은 요일 결정이라 자리가 달라서다.
    // 한 편집이라 둘 다 되거나 둘 다 안 된다(사용자 결정 2026-09-14: 유산소를 강제하지 않는다).
    if (edit.op === "replace" && fromCardio !== toCardio) {
      const removed = applyEdit(draft, { op: "remove", day_index: edit.day_index, exercise_id: edit.exercise_id }, plan);
      return "error" in removed ? removed : applyEdit(removed.draft, { op: "add", day_index: edit.day_index, to_exercise_id: edit.to_exercise_id }, plan);
    }
    // 고를 수 있는 유산소는 설정 방식 표의 13종이다([D57] A2).
    if (toCardio && !CARDIO_EXERCISES[target!.id]) return { error: `고를 수 없는 유산소입니다: ${target!.id}` };
    const current = cardioIdOn(plan, edit.day_index);
    if (edit.op === "add") {
      if (current) return { error: "그 요일에는 이미 유산소가 있어요." };
    } else if (current !== resolve((edit as { exercise_id: string }).exercise_id)!.id) {
      return { error: `그 요일에 ${(edit as { exercise_id: string }).exercise_id} 가 없습니다.` };
    }
    const day = cardioDay(week, edit.day_index, toCardio);
    if (!toCardio) {
      day.cardio_override = "none";
    } else {
      // 유산소 → 유산소 교체는 목표를 새 운동의 설정 방식으로 걸러 들고 간다(A14). `add` 는 목표 없이 도스로 시작한다.
      const previous = edit.op === "replace" ? parseCardioOverride(day.cardio_override) : undefined;
      const kept = previous && previous !== "none" && previous.target ? keepForForm(previous.target, target!.id) : undefined;
      day.cardio_override = kept ? { exercise_id: target!.id, target: kept } : { exercise_id: target!.id };
    }
    return { draft: { ...(root as object), week } };
  }

  let day = week.find((d) => d.day_index === edit.day_index);

  if (!day) {
    if (edit.op !== "add") return { error: "그 요일에 편집할 운동이 없습니다." };
    // 휴식일에 처음 넣는 경우 — 드래프트에 없던 날이라 만들어 준다. focus 는
    // 확장이 근육군으로 다시 만들므로(백로그 011) 빈 값이어도 된다.
    day = { day_index: edit.day_index, session_type: LIFT_SESSION, focus: "", items: [] };
    week.push(day);
    week.sort((a, b) => Number(a.day_index) - Number(b.day_index));
  }

  const items: DraftItem[] = Array.isArray(day.items) ? day.items.map((i) => ({ ...(i as DraftItem) })) : [];

  if (edit.op === "add") {
    // 같은 종목을 두 번 넣을 수 있으면 그 날에 같은 줄이 두 개 그려지고 볼륨도
    // 두 번 잡힌다. 후보 목록은 이미 있는 종목을 빼 주지만 API 는 직접 부를 수 있다.
    if (items.some((i) => i.exercise_id === target!.id)) {
      return { error: `${target!.name_ko}은(는) 그 요일에 이미 있어요.` };
    }
    // role·rep_intent 는 확장의 기본값과 같은 값을 명시해 둔다 — 추가한 종목이
    // 그 날의 보조 운동으로 들어간다(주 운동을 밀어내지 않는다).
    //
    // **order 는 최댓값+1 이다.** `items.length + 1` 로 하면 앞서 뭔가를 뺀 뒤엔
    // 남은 항목과 번호가 겹친다(remove 는 번호를 다시 매기지 않는다). 겹치면
    // 표시 순서만이 아니라 **어느 종목이 그 근육군의 주 운동이 되는지**가 흔들린다
    // (`expand.ts` 는 order 최솟값으로 primary 를 고른다).
    const maxOrder = items.reduce((m, i) => (typeof i.order === "number" && i.order > m ? i.order : m), 0);
    items.push({
      kind: "strength",
      exercise_id: target!.id,
      role: "accessory",
      order: maxOrder + 1,
      rep_intent: "hypertrophy",
      user_pick: true,
    });
    // 휴식일이었다면 근력 세션으로 올린다. 안 하면 확장이 이 날 항목을 통째로 버린다.
    if (day.session_type !== "lift" && day.session_type !== "lift_plus_cardio") {
      day.session_type = LIFT_SESSION;
    }
  } else {
    const index = items.findIndex((i) => i.exercise_id === edit.exercise_id);
    if (index < 0) return { error: `그 요일에 ${edit.exercise_id} 가 없습니다.` };
    if (edit.op === "remove") {
      items.splice(index, 1);
    } else if (edit.op === "retarget") {
      // 드래프트 필드 하나다 — 재확장이 이 값으로 렙 범위를 다시 고른다
      // (`loading.ts` `repRangeFor`). 세트 수·무게는 여전히 코드가 정한다(INV-1).
      //
      // `user_pick` 을 세운다: 범위를 손댔다는 건 그 종목을 지키겠다는 뜻이라
      // 볼륨 예산에 밀려 사라지면 방금 정한 것이 통째로 없어진다(`tune` 과 같다).
      items[index] = { ...items[index], rep_intent: edit.rep_intent, user_pick: true };
    } else if (edit.op === "tune") {
      // 값은 드래프트에 남는다 — 다른 편집으로 재확장해도 사용자가 정한 값이 살아남는다.
      // `null` 이면 지운다: 코드가 계산한 값으로 되돌아간다.
      const item = { ...items[index] };
      if (edit.sets !== undefined) {
        if (edit.sets === null) delete item.sets_override;
        else item.sets_override = edit.sets;
      }
      if (edit.load_kg !== undefined) {
        if (edit.load_kg === null) delete item.load_kg_override;
        else item.load_kg_override = edit.load_kg;
      }
      // 세트·무게를 손댔다는 건 그 종목을 지키겠다는 뜻이다 — 볼륨 예산에 밀려
      // 사라지면 방금 정한 값이 통째로 없어진다.
      item.user_pick = true;
      items[index] = item;
    } else {
      // **role·rep_intent·order 를 그대로 둔다** — 같은 자리에 다른 종목이다.
      // 이게 "약간 변형"의 정의고, 바꾸면 그 날 렙 범위가 같이 흔들린다.
      // 다만 세트·무게 조정은 **그 종목에 대한** 값이라 같이 지운다. P1 의 이유·대체 운동도 옛 종목 것이다.
      const { sets_override: _s, load_kg_override: _l, reason: _r, alternatives: _a, ...rest } = items[index]!;
      items[index] = { ...rest, exercise_id: target!.id, user_pick: true };
    }
  }

  day.items = items;
  return { draft: { ...(root as object), week } };
}

/**
 * 유산소 결정을 둘 요일. 드래프트에 없던 날(휴식일)이면 만든다 — 생성이 비워 둔 날일 뿐 막을 이유가 없다
 * (030 GM0 Q2, 사용자 결정 2026-09-14). 근력이 없는 날은 유산소가 있으면 `cardio_only`, 없으면 `rest`.
 */
function cardioDay(week: DraftDay[], dayIndex: number, hasCardio: boolean): DraftDay {
  let day = week.find((d) => d.day_index === dayIndex);
  if (!day) {
    day = { day_index: dayIndex, session_type: "rest", focus: "", items: [] };
    week.push(day);
    week.sort((a, b) => Number(a.day_index) - Number(b.day_index));
  }
  if (day.session_type !== "lift" && day.session_type !== "lift_plus_cardio") day.session_type = hasCardio ? "cardio_only" : "rest";
  return day;
}

/**
 * 빈 주의 드래프트([D75]) — 7일 전부 휴식일이고 **유산소 결정도 `"none"`** 이다. 근력만 비우면
 * 확장기가 프로필 도스로 유산소를 놓아 「빈 주에 사이클 3개」가 된다(백로그 069). 확장기는 안 건드리고
 * 요일 결정이 마지막에 덮는 장치(`cardioDay`·`parseCardioOverride`)를 그대로 쓴다.
 */
export function blankDraft(): { week: DraftDay[] } {
  return { week: [0, 1, 2, 3, 4, 5, 6].map((day_index) => ({ day_index, session_type: "rest", focus: "", items: [], cardio_override: "none" })) };
}

/** 수동 주의 드래프트에 유산소 결정이 없는 날을 「뺐다」로 채운다([D75]) — 옛 빈 주(`week: []`) 호환. 결정이 있는 날·항목은 그대로. */
export function normalizeManualDraft(draft: unknown): unknown {
  const root = draft as { week?: unknown } | null;
  if (!root || typeof root !== "object" || !Array.isArray(root.week)) return draft;
  const week: DraftDay[] = root.week.map((d) => ({ ...(d as DraftDay) }));
  for (const day_index of [0, 1, 2, 3, 4, 5, 6]) {
    const day = week.find((d) => d.day_index === day_index);
    if (!day) week.push({ day_index, session_type: "rest", focus: "", items: [], cardio_override: "none" });
    else if (day.cardio_override === undefined) day.cardio_override = "none";
  }
  week.sort((a, b) => Number(a.day_index) - Number(b.day_index));
  return { ...(root as object), week };
}

/** 저장된 플랜에서 그 요일 유산소 줄의 id. */
const cardioIdOn = (plan: unknown, dayIndex: number): string | undefined =>
  ((plan as { week?: Array<{ day_index?: number; exercises?: Array<{ exercise_id?: string; modality?: string }> }> } | undefined)?.week ?? [])
    .find((d) => d.day_index === dayIndex)?.exercises?.find((e) => e.modality === "cardio")?.exercise_id;

/**
 * 저장된 플랜에서 근력 없는 날의 유산소 줄을 그 날의 `cardio_override` 로 옮겨 적는다. 이미 결정이 있으면 그대로.
 * 근력 유무는 **최종 플랜**으로 본다 — 금기로 빠진 종목이 드래프트에 남은 날도 확장에서는 휴식일이다(codex N1 R1).
 * **HIIT 만** 방식·시간을 목표로 옮긴다 — id 만 옮기면 옛 휴식일 HIIT 가 도스 LISS 로 바뀐다(codex N1 R1). LISS 는 id 만:
 * 목표는 사용자 결정으로 읽혀 직전 주 기록 복사([D57] A10)를 막는데, id 만으로도 도스 LISS + 그 복사라 원래와 같다(codex N1 R2).
 */
function pinRestDayCardio(week: DraftDay[], plan: unknown): void {
  type Line = { exercise_id?: string; modality?: string; cardio_detail?: unknown };
  for (const d of (plan as { week?: Array<{ day_index?: number; exercises?: Line[] }> } | undefined)?.week ?? []) {
    const line = d.exercises?.find((e) => e.modality === "cardio");
    if (typeof d.day_index !== "number" || !line?.exercise_id || d.exercises!.some((e) => e.modality !== "cardio")) continue;
    const day = cardioDay(week, d.day_index, true);
    if (day.cardio_override !== undefined) continue;
    const target = parseCardioTarget(line.cardio_detail);
    day.cardio_override = target?.style === "HIIT" ? { exercise_id: line.exercise_id, target } : { exercise_id: line.exercise_id };
  }
}

/** 그 날에 실제로 편성된 항목. 드래프트에 날이 없거나 items 가 비면 휴식일이다. */
const itemsOf = (day: DraftDay | undefined): DraftItem[] =>
  (day && Array.isArray(day.items) ? (day.items as DraftItem[]) : []).map((i) => ({ ...i }));

/**
 * 요일 이동(백로그 018 · [D22-4]).
 *
 * | 대상 요일 | 동작 |
 * |---|---|
 * | 비어 있음(휴식일) | 그냥 옮긴다 — `swap`·`merge` 가 같은 결과라 클라이언트가 묻지 않는다 |
 * | 운동이 있음 | `swap` 두 날을 통째로 교환 · `merge` 두 날이 대상 날에 모이고 원래 날은 휴식일 |
 *
 * **덮어쓰기는 없다**(D22-4). "교체"는 맞바꾸기다 — 덮어쓰면 대상 날 운동이 그
 * 주에서 사라지고 되돌릴 경로가 없다.
 */
function moveDay(
  root: { week?: unknown },
  week: DraftDay[],
  edit: { op: "move"; day_index: number; to_day_index: number; mode: "swap" | "merge" },
): { draft: unknown; swapped: boolean } | { error: string } {
  const from = week.find((d) => d.day_index === edit.day_index);
  const to = week.find((d) => d.day_index === edit.to_day_index);
  const fromItems = itemsOf(from);
  const toItems = itemsOf(to);

  // **원본이 비어 있어도 거절하지 않는다.** 계약 §2.2 에 그런 400 이 없고, `swap`
  // 은 대칭이라 빈 날과 맞바꾸는 것은 반대 방향으로 옮기는 것과 같은 뜻이다.
  // (계약에 없는 거절을 코드가 만들면 그게 곧 D20-1 이 걷어낸 정책 게이트다.)

  /** 그 요일 자리를 확보한다 — 드래프트에 없던 날(휴식일)이면 만든다. */
  const slotFor = (dayIndex: number, existing: DraftDay | undefined): DraftDay => {
    if (existing) return existing;
    // focus 는 확장이 근육군으로 다시 만든다(백로그 011) — 빈 값이어도 된다.
    const made: DraftDay = { day_index: dayIndex, session_type: LIFT_SESSION, focus: "", items: [] };
    week.push(made);
    week.sort((a, b) => Number(a.day_index) - Number(b.day_index));
    return made;
  };

  const target = slotFor(edit.to_day_index, to);
  const source = slotFor(edit.day_index, from);

  // **유산소 결정(`cardio_override`)은 그 날 운동을 따라간다** — 남겨 두면 엉뚱한 날의 유산소가
  // 바뀐다. 도스 배치는 여전히 재확장이 다시 계산한다.
  const fromOverride = from?.cardio_override;
  const toOverride = to?.cardio_override;
  const setOverride = (d: DraftDay, value: unknown) => {
    if (value === undefined) delete d.cardio_override;
    else d.cardio_override = value;
  };
  // **대상이 완전히 비었으면(근력이 없고 유산소 결정이 없거나 「뺐다」) swap 과 같다**(계약 §2.2 — 클라이언트가 묻지 않는 근거).
  // 「뺐다」(`"none"`)를 「결정 있음」으로 세면 빈 주([D75] — 7일 전부 `"none"`)의 빈 날로 옮길 때 merge 갈래로 빠져
  // 원래 날의 유산소가 사라진다.
  const targetEmpty = toItems.length === 0 && (toOverride === undefined || toOverride === "none");
  if (edit.mode === "merge" && !targetEmpty) {
    // 대상 날 결정이 이긴다(하루 1회) — 대상에 근력이 없어도(유산소만 있는 날) 마찬가지다.
    // 원래 날의 `"none"` 은 가져가지 않는다: 「그 날엔 안 한다」가 대상 날 유산소를 지우면 안 된다.
    setOverride(target, toOverride ?? (fromOverride === "none" ? undefined : fromOverride));
    // 원래 날은 휴식일이 된다 — 결정이 있던 날은 「뺐다」로 남긴다(「뺐다」는 옮겨지지 않았고, 옮기지 못한 유산소 결정 자리에
    // 도스 유산소가 되살아나면 안 된다 — 빈 주([D75])에서 특히). 결정이 없던 날(AI 배치)은 그대로 재확장이 다시 계산한다.
    setOverride(source, fromOverride === undefined ? undefined : "none");
  } else {
    setOverride(target, fromOverride);
    setOverride(source, toOverride);
  }
  // 고정한 서킷 템플릿(N7a)도 그 날을 따라간다 — 기록이 `carry` 로 옮겨 가는 것과 맞춘다(codex N7a R4).
  // merge 는 대상 날 것이 이긴다(유산소 결정과 같다).
  const fromCircuit = from?.circuit_template;
  const toCircuit = to?.circuit_template;
  const setCircuit = (d: DraftDay, value: unknown) => {
    if (value === undefined) delete d.circuit_template;
    else d.circuit_template = value;
  };
  if (edit.mode === "merge" && !targetEmpty) {
    setCircuit(target, toCircuit ?? fromCircuit);
    setCircuit(source, undefined);
  } else {
    setCircuit(target, fromCircuit);
    setCircuit(source, toCircuit);
  }

  if (edit.mode === "merge" && toItems.length > 0) {
    // **중복은 대상 날 것을 남긴다.** 같은 종목이 한 날에 두 줄이면 볼륨도 두 번
    // 잡힌다 — `add` 가 중복을 막는 것과 같은 이유다.
    const have = new Set(toItems.map((i) => i.exercise_id));
    const merged = [...toItems];
    // order 는 대상 날의 최댓값 뒤로 이어 붙인다. 겹치면 어느 종목이 그 근육군의
    // 주 운동이 되는지가 흔들린다(`expand.ts` 는 order 최솟값으로 primary 를 고른다).
    let order = merged.reduce((m, i) => (typeof i.order === "number" && i.order > m ? i.order : m), 0);
    for (const item of fromItems) {
      if (have.has(item.exercise_id)) continue;
      order += 1;
      merged.push({ ...item, order });
    }
    target.items = merged;
    source.items = [];
    source.session_type = "rest";
  } else {
    // 맞바꾸기(대상이 비어 있으면 그냥 옮기는 것과 같다).
    target.items = fromItems;
    source.items = toItems;
    const fromType = source.session_type;
    source.session_type = toItems.length > 0 ? target.session_type : "rest";
    target.session_type = fromType;
  }

  // 세션 종류가 항목과 어긋나면 확장이 그 날 항목을 통째로 버린다.
  for (const d of [target, source]) {
    const has = Array.isArray(d.items) && d.items.length > 0;
    if (has && d.session_type !== "lift" && d.session_type !== "lift_plus_cardio") d.session_type = LIFT_SESSION;
    if (!has) d.session_type = "rest";
  }

  // **실제로 합쳐졌을 때만 `false`** — 그 밖(맞바꿈 · 빈 대상으로의 merge)은 기록도 운동을 따라간다([D79] · `swapDayRecords`).
  return { draft: { ...(root as object), week }, swapped: !(edit.mode === "merge" && !targetEmpty) };
}

/** 워커가 `weekly_plans/{uid}/weeks/{week}` 에 남기는 문서. */
export interface SavedWeek {
  plan?: unknown;
  draft?: unknown;
  profile?: UserProfile;
  week_start_date?: string;
  /**
   * 이 플랜을 만들 때 쓴 실측 기록(계약 §1). 재확장이 **같은 입력**을 다시 먹어야
   * 진행 결정이 보존된다. 이 주의 `sessions` 가 아니다 — 그건 지금 하고 있는
   * 운동이고, 그걸 읽으면 편집할 때마다 처방이 흔들린다.
   */
  prior_logs?: unknown[];
  /** 요일별 실측 기록(§2.4). 진행의 입력은 **다음 주** 생성이 읽어 간다. */
  sessions?: Record<string, unknown>;
  /** 요일별 미완료 입력. 플랜 교체 때 삭제하지 않고 닫아 복구 근거를 남긴다. */
  progress_drafts?: Record<string, unknown>;
}

/** HTTP 로 옮기기만 하면 되는 결과. `save` 가 있으면 그것만 되쓴다. */
export interface EditOutcome {
  code: number;
  body: Record<string, unknown>;
  save?: { plan: unknown; draft: unknown } & Record<string, unknown>;
  /**
   * 저장은 했지만 코드 규칙과는 어긋나는 점(볼륨 상한 초과 등). 사용자에게는
   * 보여 주지 않는다([D20-1] 경고 없음) — 호출 층이 로그로만 남긴다.
   */
  policyNotes?: string[];
  /**
   * 요일 교환([D79]) — 저장할 때 두 날의 `sessions`·`progress_drafts` 를 운동과 함께 맞바꾼다(`swapDayRecords`).
   * 문서의 최신 기록은 호출 층의 트랜잭션만 알므로 여기서는 「어느 두 날인가」만 넘긴다.
   */
  carry?: { from: number; to: number };
}

/**
 * 편집의 **판단 전부**가 여기 있다 — 배포본(index.ts)과 dev-server 가 같은 규칙을
 * 쓰도록 순수 함수로 뽑았다. 호출자는 문서를 읽고, 결과를 쓰고, 코드를 그대로
 * 응답하면 된다.
 */
export function editSavedWeek(saved: SavedWeek | null, uid: string, body: unknown, weekKey = "", previousWeeks: SavedWeek[] = []): EditOutcome {
  const edit = parseEdit(body);
  if ("error" in edit) return { code: 400, body: { status: "error", message: edit.error } };

  /**
   * 빈 주(백로그 016 §6.5 7 · [D20-2]) — **LLM 없이 플랜이 생기는 경로다.**
   * 새 구조가 없다: 빈 주 = 빈 드래프트(`week: []`)이고, 채우는 것은 기존 `add`
   * 경로 그대로다. 씨앗을 받는 게 기본 경험이고 이건 그 밖으로 나가는 문이다.
   *
   * **저장된 플랜이 없어도 된다** — 다른 op 와 달리 이건 *만드는* 것이라 404 가 아니다.
   * 프로필은 본문에서 받아 생성 경로와 **같은 검증기**를 태운다(신뢰 경계).
   */
  if (edit.op === "blank") {
    const checked = validateProfile(edit.profile);
    if ("error" in checked) return { code: 400, body: { status: "error", message: checked.error } };
    if (!WEEK_KEY_RE.test(weekKey)) {
      return { code: 400, body: { status: "error", message: "빈 주는 YYYY-MM-DD 로 만들어야 합니다(current 불가)." } };
    }
    // **주차 번호를 지키다.** 5주차를 비웠는데 1주차가 되면 `plan_id` 가 `uid-w1` 로
    // 되돌아가 주차 연속성과 기록 연결이 끊긴다. 새 주는 이전 주차에서 잇고, 이력이 없으면 1이다.
    const priorWeek = (saved?.plan as { plan_meta?: { week_number?: unknown } } | undefined)?.plan_meta?.week_number;
    // Only the caller's server-read, earlier week can seed a new manual week.
    // Existing weeks keep the original snapshot even if it is an empty array.
    const previous = !saved ? previousWeeks.filter((w) => w.week_start_date && w.week_start_date < weekKey)
      .sort((a, b) => b.week_start_date!.localeCompare(a.week_start_date!))[0] : undefined;
    const previousNumber = (previous?.plan as { plan_meta?: { week_number?: unknown } } | undefined)?.plan_meta?.week_number;
    const weekNumber = typeof priorWeek === "number" ? priorWeek
      : typeof previousNumber === "number" && Number.isInteger(previousNumber) && previousNumber >= 1 ? previousNumber + 1 : 1;
    const priorLogs = saved ? saved.prior_logs ?? [] : recentPriorLogs(previousWeeks, weekKey);
    return expandAndSave(
      blankDraft(),
      checked.profile,
      uid,
      weekKey,
      weekNumber,
      // 진행 결정의 입력은 그대로 잇는다 — 비운 것은 계획이지 지난 주 실측이 아니다.
      priorLogs,
      // **명시적으로 싣는다** — 저장이 깊은 병합이라 생략하면 AI 주 위에서 `"ai"` 가 남는다(D54 ①).
      "manual",
      { profile: checked.profile, prior_logs: priorLogs },
    );
  }

  if (!saved) return { code: 404, body: { status: "error", message: "저장된 플랜이 없습니다." } };

  // 이 기능 전에 저장된 플랜에는 드래프트가 없다. 재확장할 입력이 없으므로
  // 편집할 수 없다 — 조용히 실패하지 않고 말해 준다.
  if (!saved.draft || !saved.profile) {
    return {
      code: 409,
      body: {
        status: "error",
        message: "이 플랜은 편집할 수 없습니다(생성 정보 없음). 다음 주 플랜부터 편집할 수 있어요.",
      },
    };
  }

  // **이동 잠금은 없다**(계약 §2.2 · [D79]). 교환하면 그 날의 기록·진행 초안도 운동을 따라가므로(`carry` →
  // 호출 층이 `swapDayRecords` 로 같은 트랜잭션에서 옮긴다) 기록이 엉뚱한 운동 옆에 남지 않는다.
  // D75 이전에 만든 빈 주(`week: []` · `source: "manual"`)는 요일 결정이 없어 재확장 때 도스 유산소가 붙는다 —
  // 편집 전에 7일 「뺐다」로 채운다(결정이 있는 날은 그대로). 생성(`ai`) 주는 도스 배치가 맞으니 건드리지 않는다.
  const draftIn = (saved.plan as { plan_meta?: { source?: unknown } } | undefined)?.plan_meta?.source === "manual"
    ? normalizeManualDraft(saved.draft)
    : saved.draft;
  const edited = applyEdit(draftIn, edit, saved.plan);
  if ("error" in edited) return { code: 400, body: { status: "error", message: edited.error } };

  const weekNumber = (saved.plan as { plan_meta?: { week_number?: unknown } } | undefined)?.plan_meta?.week_number;
  const outcome = expandAndSave(
    edited.draft,
    saved.profile,
    uid,
    saved.week_start_date ?? "",
    typeof weekNumber === "number" ? weekNumber : 1,
    saved.prior_logs ?? [],
    // 편집은 매번 다시 확장한다 — 넘기지 않으면 편집 한 번에 출처가 사라진다(D54 ①).
    savedSource(saved),
    {},
    // 서킷이 있던 주는 재확장에서도 서킷을 낸다 — 플래그는 생성 설정이라 편집 경로엔 없다(N7a).
    savedHasCircuit(saved),
  );
  if (outcome.save && edit.op === "move" && edited.swapped) outcome.carry = { from: edit.day_index, to: edit.to_day_index };
  return outcome;
}

/**
 * 저장된 플랜의 출처. 없던 문서는 `undefined`(편집 뒤에도 키 없음). **허용 밖 값은 `manual` 로
 * 명시한다** — 그대로 넘기면 스키마에 걸려 편집이 500 이고, 빼기만 하면 저장이 깊은 병합이라
 * 문서에 옛 값이 남는다(codex 039 N2 R1). 모를 때 AI 로 부르지 않는다(039 §1).
 */
export function savedSource(saved: SavedWeek | null): "ai" | "manual" | undefined {
  const source = (saved?.plan as { plan_meta?: { source?: unknown } } | undefined)?.plan_meta?.source;
  return source === undefined ? undefined : source === "ai" ? "ai" : "manual";
}

/** 저장된 플랜에 서킷 묶음이 있는가(N7a) — 재확장이 같은 모양을 내도록. */
export function savedHasCircuit(saved: SavedWeek | null): boolean {
  const week = (saved?.plan as { week?: Array<{ exercises?: Array<{ circuit?: unknown }> }> } | undefined)?.week ?? [];
  return week.some((d) => (d.exercises ?? []).some((e) => e.circuit !== undefined));
}

/** `YYYY-MM-DD`. 빈 주는 어느 주인지 스스로 말해야 한다 — `current` 로는 만들 수 없다. */
const WEEK_KEY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;

/**
 * 드래프트를 확장해 저장 결과로 만든다. **편집과 빈 주가 같은 경로를 쓴다** —
 * 볼륨 상한·금기 필터·부하 계산이 생성 때와 같은 코드로 걸린다(INV-1).
 */
function expandAndSave(
  draft: unknown,
  profile: UserProfile,
  uid: string,
  weekStartDate: string,
  weekNumber: number,
  priorLogs: unknown[],
  source: "ai" | "manual" | undefined,
  extraSave: Record<string, unknown> = {},
  circuits = false,
): EditOutcome {
  let expanded;
  try {
    expanded = expandDraftToWeeklyPlan({
      draft,
      profile,
      userId: uid,
      weekStartDate,
      weekNumber,
      // 생성이 쓴 것과 **같은 실측 기록**을 다시 먹인다(계약 §1 · D22-6). 비우면
      // 편집 한 번에 진행 결정이 통째로 날아가 처방이 1주차로 되돌아간다.
      priorLogs,
      disclaimer: MEDICAL_DISCLAIMER,
      source,
      circuits,
    });
  } catch (err) {
    return { code: 500, body: { status: "error", message: `플랜 확장 오류: ${(err as Error).message}` } };
  }

  // **정책 위반으로 편집을 거절하지 않는다**([D20-1] 추천일 뿐, 강제도 경고도
  // 없다). 주간 볼륨 상한 초과·훈련일 수 부족은 사용자가 자기 플랜에 대해 내린
  // 결정이므로 그대로 저장한다. `problems` 는 여기서 소비하지 않고 로그로만 흘린다
  // — 화면에 띄우면 그게 곧 경고다.
  //
  // 다만 **구조가 깨진 플랜은 저장하지 않는다.** 정책과 파손은 다르다: 계약
  // 스키마를 통과하지 못하는 플랜을 정본에 넣으면 다음 조회에서 화면이 깨진다.
  // 편집 경로가 만들 수 있는 파손은 없어야 정상이므로(요일·중복·id 는 앞에서
  // 다 막았다) 여기까지 오면 엔진 버그다 → 500.
  const shape = checkWeeklyPlan(expanded.plan);
  if (!shape.ok) {
    return {
      code: 500,
      body: { status: "error", message: `플랜 스키마 위반: ${shape.errors.join("; ")}` },
    };
  }

  return {
    code: 200,
    body: { status: "ok", plan: expanded.plan, warnings: expanded.warnings },
    save: { plan: expanded.plan, draft: expanded.draft, ...extraSave },
    // 정책 위반은 응답이 아니라 로그로만 남는다(호출 층이 찍는다).
    ...(expanded.problems.length > 0 ? { policyNotes: expanded.problems } : {}),
  };
}

/**
 * 그 자리에 넣을 만한 종목. 873종을 그대로 내려보내지 않는 이유는 UI 가 아니라
 * 안전이다: 장비·금기 필터가 서버에 있어야 클라이언트가 우회할 수 없다.
 *
 * `fromId` 가 있으면 **교체**(같은 근육군), 없으면 **추가**(그 날이 이미 쓰는
 * 근육군). 그 날에 이미 있는 종목은 뺀다.
 */
/** 후보 목록에 한 번에 담는 개수. 추천이든 검색이든 화면이 감당할 상한이다. */
const CANDIDATE_LIMIT = 40;

export function candidatesFor(
  saved: SavedWeek | null,
  dayIndex: unknown,
  fromId: string,
  query = "",
  browse: string[] = [],
  limit: unknown = CANDIDATE_LIMIT,
): EditOutcome {
  if (typeof dayIndex !== "number" || !Number.isInteger(dayIndex) || dayIndex < 0 || dayIndex > 6) {
    return { code: 400, body: { status: "error", message: "day_index 는 0–6 정수여야 합니다." } };
  }
  if (!saved) return { code: 404, body: { status: "error", message: "저장된 플랜이 없습니다." } };
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
    return { code: 400, body: { status: "error", message: "limit 은 1–1000 정수여야 합니다." } };
  }
  const unknownMuscle = browse.find((m) => !PRIMARY_MUSCLES.includes(m));
  if (unknownMuscle) {
    return { code: 400, body: { status: "error", message: `카탈로그에 없는 근육입니다: ${unknownMuscle}` } };
  }
  const profile = saved.profile;
  if (!profile) {
    return { code: 409, body: { status: "error", message: "이 플랜은 편집할 수 없습니다(생성 정보 없음)." } };
  }

  const week = ((saved.plan as { week?: unknown } | undefined)?.week ?? []) as Array<{
    day_index?: number;
    exercises?: Array<{ exercise_id?: string }>;
  }>;
  const day = week.find((d) => d.day_index === dayIndex);
  const present = new Set((day?.exercises ?? []).map((e) => e.exercise_id));

  const base = fromId ? resolve(fromId) : undefined;
  if (fromId && !base) {
    return { code: 400, body: { status: "error", message: `카탈로그에 없는 운동입니다: ${fromId}` } };
  }
  // 교체면 그 종목의 근육군, 추가면 그 날이 이미 쓰는 근육군. 둘 다 비면 제한 없음.
  const muscles = base
    ? base.primary_muscles
    : [...new Set((day?.exercises ?? []).flatMap((e) => resolve(e.exercise_id ?? "")?.primary_muscles ?? []))];

  /**
   * **전체 검색 — 추천 밖으로 나가는 탈출구**([D20-1](../../../docs/decisions/mvp-decision-log.md) ·
   * 백로그 016 §6.5 3).
   *
   * 추천 목록은 걸러도 된다(그게 곧 추천이다). 하지만 걸러진 것만 고를 수 있으면
   * 그건 추천이 아니라 **강제**다. 검색은 장비와 추천 근육군을 넘되, 명시한 부위는 지킨다 —
   * D20-1 이 "강제도 경고도 없다"로 정한 자세의 실물이다.
   *
   * **다만 부상 금기는 넘지 않는다.** [FR-GEN-4](../../../docs/product/01-prd.md) 가
   * "최종 플랜의 금기 교집합 = 0" 을 하드 AC 로 못박아, 금기 종목은 골라도 재확장이
   * 다시 빼낸다(`expand.ts` `excludeContraindicated`). 그걸 검색 결과에 실으면
   * **고르면 조용히 사라지는 항목**이 되는데, 그건 D20-1 이 없애려던 바로 그 경험이다.
   * 이 선을 옮기려면 FR-GEN-4 를 바꿔야 하고 그건 [G4](../../../docs/guides/execution-graph.md) 다.
   *
   * **경고 문구를 붙이지 않는다.** 장비 밖이라고 표시를 달면 그게 곧 경고이고,
   * 안전은 상시 면책 문구로만 남긴다는 결정과 충돌한다. 응답 모양도 그대로다.
   */
  const excludeMuscles = contraindicatedMuscles(profile).muscles;
  /**
   * **장비·도구 좁히기는 생성 경로와 같은 규칙을 쓴다**(`profileFilter`). 여기서
   * `profile.equipment` 만 보던 시절엔 `bodyweight_only`(프리셋이 빈 배열이다)가
   * "제한 없음"으로 읽혀, 아무 장비도 없다고 답한 사람에게 케틀벨·폼롤러가
   * 후보로 나왔다. 규칙을 두 벌 적으면 반드시 이렇게 갈린다.
   * `undefined` 는 제한 없음이다 — `find` 에 빈 배열을 주면 오히려 다 사라진다.
   */
  const equipmentFilter = profileFilter(profile);

  /**
   * **부위별 개수**(백로그 020). 칩에 개수를 실어야 *눌러서 0개가 나오는 부위*가
   * 사라진다 — `목` 은 헬스장 프리셋 전부에서 0이고, 어깨 부상이면 `shoulders` 가
   * 통째로 0이다. 개수가 0인 부위는 클라이언트가 아예 그리지 않는다.
   *
   * **17종 근육 그대로 센다.** 한국어 부위 11분류는 화면의 표시 축이라
   * 클라이언트가 갖는다(`miniapp/src/App.tsx` `MUSCLE_GROUP`) — 계약에 한글
   * 라벨을 들이면 taxonomy 가 두 벌이 된다.
   *
   * **목록이 거르는 것을 개수도 똑같이 거른다** — 그 날에 이미 있는 종목과 교체
   * 대상 자신까지. 요일마다 숫자가 한둘 흔들리지만, 어긋나면 *칩이 1인데 눌러서
   * 빈 목록*이 나온다(맨몸 `종아리` 는 후보가 하나뿐이라 실제로 일어난다).
   * 개수의 뜻은 "카탈로그에 몇 개"가 아니라 **"지금 고를 수 있는 게 몇 개"** 다.
   */
  const muscle_counts: Record<string, number> = {};
  for (const e of find({ ...equipmentFilter, excludeMuscles })) {
    if (e.modality === "cardio" || present.has(e.id) || e.id === base?.id) continue;
    for (const m of new Set(e.primary_muscles)) muscle_counts[m] = (muscle_counts[m] ?? 0) + 1;
  }

  // **정규화한 뒤에 가른다.** 공백뿐인 `q` 를 검색으로 받으면 빈 문자열이 모든
  // 이름에 걸려, 장비·근육군 필터를 우회한 40개가 아무 이유 없이 나온다.
  const q = query.trim();
  if (q) {
    const matches = createExerciseMatcher(q);
    const hits = find({ excludeMuscles, ...(browse.length > 0 ? { primaryMuscles: browse } : {}) })
      .filter((e) => e.modality !== "cardio" && !present.has(e.id) && e.id !== base?.id)
      // **OR 검색**(사용자 결정 2026-09-08) — 공백으로 나눈 낱말 중 하나라도 이름·id 에 들어가면 맞는다.
      // 「덤벨 프레스」를 치면 덤벨 종목과 프레스 종목이 다 나온다. 좁히려면 부위 칩을 쓴다.
      .filter((e) => matches([e.name_ko, e.id, e.name]))
      // 짧은 이름이 먼저다 — `"스쿼트"` 를 치면 `바벨 스쿼트` 가 `싱글 레그 덤벨 스쿼트`
      // 보다 위에 온다. 같은 길이면 이름순으로 결정적이게 자른다.
      .sort((a, b) => a.name_ko.length - b.name_ko.length || a.name_ko.localeCompare(b.name_ko, "ko") || a.id.localeCompare(b.id));
    const candidates = hits.slice(0, limit)
      .map((e) => ({ id: e.id, name_ko: e.name_ko, equipment: e.equipment, primary_muscles: e.primary_muscles }));
    return { code: 200, body: { status: "ok", candidates, muscle_counts, total: hits.length } };
  }

  /**
   * **부위 훑기**(백로그 020). `browse` 가 있으면 그 날의 근육군 대신 이걸로 좁힌다 —
   * 초보자는 고를 이름을 몰라 `q` 탈출구를 쓸 수 없고, 추천 40개는 873종의
   * 가나다순 조각이라 "등 운동을 훑어보겠다"가 성립하지 않았다.
   *
   * **`q` 와 달리 장비는 지킨다.** 검색은 이름을 아는 사람이 그것을 집으러 가는
   * 길이지만(D20-1 탈출구), 훑기는 **추천의 확장**이다 — `bodyweight_only`
   * 사용자에게 등 114종을 열면 그중 108개가 못 하는 것이고, 발견성을 고치려다
   * 더 나쁘게 만든다. 무제한 문은 `q` 하나로 이미 열려 있다.
   */
  const available = find({
    // **modality 로 거르지 않는다.** `strength` 로 좁히면 맨몸 111종이 통째로
    // 빠져 `bodyweight_only` 사용자에게 후보가 0개가 된다(백로그 014 §2 가 잡은
    // 것과 같은 종류의 버그다). 유산소만 아래에서 뺀다 — 그건 프로필이 정한다.
    ...(browse.length > 0 ? { primaryMuscles: browse } : muscles.length > 0 ? { primaryMuscles: muscles } : {}),
    ...equipmentFilter,
    excludeMuscles,
  })
    .filter((e) => e.modality !== "cardio" && !present.has(e.id) && e.id !== base?.id)
    .sort((a, b) => a.name_ko.localeCompare(b.name_ko, "ko") || a.id.localeCompare(b.id));
  const candidates = available.slice(0, limit)
    .map((e) => ({ id: e.id, name_ko: e.name_ko, equipment: e.equipment, primary_muscles: e.primary_muscles }));

  return { code: 200, body: { status: "ok", candidates, muscle_counts, total: available.length } };
}
