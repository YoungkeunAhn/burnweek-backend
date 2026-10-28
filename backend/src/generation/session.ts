/**
 * 세션 기록 — 계약 [§2.4](../../../docs/specs/features/001-weekly-plan-generation/contracts/generation-api.md).
 *
 * **판단 전부가 여기 있다** — 배포본(`index.ts`)과 dev-server 가 같은 규칙을 쓰기
 * 위해서다(`edit.ts` 와 같은 구조). 호출 층은 문서를 읽고, 결과를 되쓰고, 코드를
 * 그대로 돌려주는 것만 한다.
 *
 * 계획(`plan.week[].exercises[].sets[].target_*`)과 실측(`sessions`)은 **다른 자리에
 * 산다.** 섞으면 다음 주 진행이 자기가 처방한 값을 읽는다.
 */
import { checkPerformedSession } from "../schemas/validate";
import { cardioRangeProblems, type CardioFields } from "./cardio";

/** HTTP 로 옮기기만 하면 되는 결과. `save` 가 있으면 그 요일에 얹는다. */
export interface SessionOutcome {
  code: number;
  body: Record<string, unknown>;
  /** `sessions.{dayIndex}` 에 **merge 로** 얹는다 — §2.2 편집과 필드가 겹치지 않는다. */
  save?: { dayIndex: number; session: unknown };
}

/** 0–6 정수만 통과한다. 경로 세그먼트라 `"01"`·`" 3"` 같은 것도 막는다. */
function parseDayIndex(raw: string): number | null {
  if (!/^[0-6]$/.test(raw)) return null;
  return Number(raw);
}

/**
 * `PUT /v1/plans/{key}/sessions/{day_index}` 의 판정.
 *
 * **멱등 upsert 다**(§2.4) — 같은 요일로 다시 보내면 덮어쓴다. 완료한 날에 한 세트를
 * 더 하고 다시 저장하는 경로가 그것이다.
 */
export function saveSessionOn(
  savedExists: boolean,
  dayIndexRaw: string,
  body: unknown,
): SessionOutcome {
  const dayIndex = parseDayIndex(dayIndexRaw);
  if (dayIndex === null) {
    return { code: 400, body: { status: "error", message: "day_index 는 0–6 정수여야 합니다." } };
  }

  const verdict = checkPerformedSession(body);
  if (!verdict.ok) {
    // `problems` 는 ajv 의 영문 진단이라 화면에 쓰지 않는다 — 한국어 `message` 가
    // 정본이고(계약 §2.2 와 같은 규약) 영문은 관측용으로만 함께 싣는다.
    return {
      code: 400,
      body: { status: "error", message: "세션 기록 형식이 올바르지 않습니다.", problems: verdict.errors },
    };
  }

  // 스키마는 칸의 모양만 본다 — 운동마다 받는 칸과 범위는 설정 방식 표가 정한다(D57 A4·A12).
  const rangeProblems = ((body as { exercises: { exercise_id: string; sets: { cardio?: CardioFields }[] }[] }).exercises)
    .flatMap((ex) => ex.sets.flatMap((set) => (set.cardio ? cardioRangeProblems(ex.exercise_id, set.cardio, { record: true }) : [])));
  if (rangeProblems.length > 0) {
    return { code: 400, body: { status: "error", message: rangeProblems[0], problems: rangeProblems } };
  }

  // 경로와 본문이 갈리면 **어느 요일 기록인지가 두 개**가 된다 — 저장 위치는 경로가
  // 정하고 진행 판정은 본문을 읽으므로, 어긋난 채 받으면 조용히 엉뚱한 날이 된다.
  const bodyDayIndex = (body as { day_index?: unknown }).day_index;
  if (bodyDayIndex !== dayIndex) {
    return {
      code: 400,
      body: { status: "error", message: `day_index 가 경로(${dayIndex})와 본문(${String(bodyDayIndex)})에서 다릅니다.` },
    };
  }

  if (!savedExists) {
    return { code: 404, body: { status: "error", message: "저장된 플랜이 없습니다." } };
  }

  return { code: 200, body: { status: "ok" }, save: { dayIndex, session: body } };
}

/**
 * 저장된 주차 문서의 `sessions` 맵 → `prior_logs` 배열(계약 §1).
 *
 * **클라이언트는 `prior_logs` 를 보내지 않는다** — 서버가 여기서 만든다. 그래야
 * 클라이언트가 낡아도 피드백 루프가 돌고, 저장된 것과 보낸 것이 어긋나는 상태가
 * 존재할 수 없다(`week_number`·`recent_exercise_ids` 와 같은 자리다).
 *
 * 요일 순으로 정렬한다 — 맵의 열거 순서에 진행 판정이 기대지 않게 한다.
 * `decideProgression` 은 세트를 모아서 보므로 순서가 결과를 바꾸지는 않지만,
 * 순서가 들쭉날쭉하면 같은 입력에 같은 결과라는 것을 확인하기 어려워진다.
 */
export function sessionsToPriorLogs(sessions: unknown): unknown[] {
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return [];
  return Object.entries(sessions as Record<string, unknown>)
    .filter(([, session]) => session && typeof session === "object")
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, session]) => session);
}

/** 세션 객체가 있는 요일. `sessions` 는 `{ "0": PerformedSession, … }` 맵이다(§2.4). */
function completedDayIndices(sessions: unknown): Set<number> {
  const out = new Set<number>();
  if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)) return out;
  for (const [key, session] of Object.entries(sessions as Record<string, unknown>)) {
    if (session && typeof session === "object" && /^[0-6]$/.test(key)) out.add(Number(key));
  }
  return out;
}

/** `week` 배열에서 완료한 요일 항목만 옛 것으로 바꾼다. 옛 `week` 가 없으면 새 것 그대로. */
function preserveWeek(saved: unknown, next: unknown, completed: Set<number>): unknown {
  const oldWeek = (saved as { week?: unknown } | null)?.week;
  const newWeek = (next as { week?: unknown } | null)?.week;
  if (!Array.isArray(oldWeek) || !Array.isArray(newWeek)) return next;
  const dayOf = (d: unknown) => Number((d as { day_index?: unknown } | null)?.day_index);
  const kept = oldWeek.filter((d) => completed.has(dayOf(d)));
  const fresh = newWeek.filter((d) => !completed.has(dayOf(d)));
  return { ...(next as object), week: [...fresh, ...kept].sort((a, b) => dayOf(a) - dayOf(b)) };
}

/**
 * 재생성 저장 직전 병합(D60 ①). **세션이 있는 요일**의 `plan.week`·`draft.week` 항목을
 * 저장돼 있던 것으로 되살린다 — 사용자가 이미 한 날은 새 플랜이 덮지 않는다.
 *
 * 요일 배치·개수·볼륨은 손대지 않는다(D60 Q2·Q7): 새 플랜이 그 요일에도 훈련일을 뒀으면
 * 옛 것이 이기고, 그래서 주 총 회수가 `days_per_week` 를 넘을 수 있다. 재확장도 하지 않는다 —
 * 완료한 날의 수치는 바이트 그대로다.
 *
 * `draft` 도 같이 되살려야 한다: 편집(`editSavedWeek`)은 저장된 드래프트를 재확장해 플랜을
 * 통째로 다시 쓰므로, 플랜만 보존하면 첫 편집에 완료한 날이 새 것으로 돌아간다. 그래서 **둘 다
 * 아니면 둘 다 아니다** — 옛 문서에 드래프트가 없으면(016 이전) 보존하지 않고 종전대로 통째
 * 교체한다(반쪽 보존은 편집이 되돌린다 · codex 044 N1 R1).
 *
 * 코드가 놓은 유산소만 있는 완료일은 드래프트에 항목이 없어 재생성 직후에는 남지만 다음 편집의
 * 재확장이 다시 배치한다 — 계약 §2.2 「코드가 놓은 유산소는 따라가지 않는다」의 종전 규칙이다
 * (044 그래프 §4 Q11).
 */
export function preserveCompletedDays(
  saved: { plan?: unknown; draft?: unknown; sessions?: unknown } | null | undefined,
  next: { plan: unknown; draft: unknown },
): { plan: unknown; draft: unknown } {
  const completed = completedDayIndices(saved?.sessions);
  const hasWeek = (x: unknown) => Array.isArray((x as { week?: unknown } | null)?.week);
  if (completed.size === 0 || !hasWeek(saved?.plan) || !hasWeek(saved?.draft)) return next;
  return {
    plan: preserveWeek(saved?.plan, next.plan, completed),
    draft: preserveWeek(saved?.draft, next.draft, completed),
  };
}
