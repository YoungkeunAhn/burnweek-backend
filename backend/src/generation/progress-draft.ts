import { swapDaySessions } from "./day-swap";
/** 진행 중 입력은 완료 세션과 분리한다. 서버는 모양과 크기만 검증하고 처방 수치를 만들지 않는다. */
export type ProgressDraftInput = {
  plan_id: string;
  plan_generated_at: string;
  base_revision: number;
  start_after_retire?: boolean;
  progress: Record<string, unknown[]>;
};

export type StoredProgressDraft = {
  plan_id: string;
  plan_generated_at?: string;
  revision: number;
  updated_at: string;
  closed: boolean;
  closed_reason?: "plan_replaced" | "session_completed";
  progress?: Record<string, unknown[]>;
};

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const shortText = (value: unknown, max = 32) => typeof value === "string" && value.length <= max;

function validCardio(value: unknown): boolean {
  if (!record(value) || Object.keys(value).some((key) => !["style", "duration", "seconds", "distance", "incline", "level", "segments"].includes(key))) return false;
  if (value.style !== "LISS" && value.style !== "HIIT") return false;
  if (!["duration", "distance", "incline", "level"].every((key) => shortText(value[key]))
    || (value.seconds !== undefined && !shortText(value.seconds))) return false;
  return Array.isArray(value.segments) && value.segments.length <= 32 && value.segments.every((segment: unknown) =>
    record(segment) && Object.keys(segment).every((key) => ["label", "min", "sec", "speed", "incline", "level"].includes(key))
    && ["label", "min", "sec", "speed", "incline", "level"].every((key) => segment[key] === undefined || shortText(segment[key], key === "label" ? 80 : 32)));
}

function validEntry(value: unknown): boolean {
  if (!record(value) || Object.keys(value).some((key) => !["done", "kg", "reps", "skip", "rest", "pain", "cardio"].includes(key))) return false;
  if (typeof value.done !== "boolean" || !shortText(value.kg) || !shortText(value.reps)) return false;
  if (value.skip !== undefined && typeof value.skip !== "boolean") return false;
  if (value.pain !== undefined && typeof value.pain !== "boolean") return false;
  if (value.rest !== undefined && (!Number.isInteger(value.rest) || (value.rest as number) < 0 || (value.rest as number) > 3600)) return false;
  return value.cardio === undefined || validCardio(value.cardio);
}

export function parseProgressDraft(value: unknown): ProgressDraftInput | null {
  if (!record(value) || Object.keys(value).some((key) => !["plan_id", "plan_generated_at", "base_revision", "start_after_retire", "progress"].includes(key))) return null;
  if (typeof value.plan_id !== "string" || !value.plan_id || value.plan_id.length > 128
    || typeof value.plan_generated_at !== "string" || !value.plan_generated_at || value.plan_generated_at.length > 64
    || (value.start_after_retire !== undefined && typeof value.start_after_retire !== "boolean")
    || !Number.isSafeInteger(value.base_revision) || (value.base_revision as number) < 0 || !record(value.progress)) return null;
  const entries = Object.entries(value.progress);
  if (entries.length > 100 || entries.some(([id, sets]) => !/^[a-zA-Z0-9_-]{1,128}$/.test(id)
    || !Array.isArray(sets) || sets.length > 100 || !sets.every(validEntry))) return null;
  // Firestore 문서 상한 1MiB보다 충분히 작게 묶는다. 입력 상태에는 미완성 숫자 문자열도 허용한다.
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > 64 * 1024) return null;
  return value as ProgressDraftInput;
}

export function readProgressDraft(value: unknown): StoredProgressDraft | null {
  if (!record(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.plan_id !== "string" || typeof value.updated_at !== "string" || typeof value.closed !== "boolean") return null;
  if (value.closed) return value as StoredProgressDraft;
  const parsed = parseProgressDraft({ plan_id: value.plan_id, plan_generated_at: value.plan_generated_at,
    base_revision: value.revision, progress: value.progress });
  return parsed ? value as StoredProgressDraft : null;
}

/** 플랜 교체 전 초안을 보존한 채 닫는다. revision을 올려 늦게 도착한 기기의 PUT도 막는다. */
export function retireProgressDrafts(raw: unknown, day?: number): Record<string, unknown> | null {
  if (!record(raw)) return null;
  const entries = Object.entries(raw).filter(([key]) => day === undefined || key === String(day));
  if (!entries.length) return null;
  const updated: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    const draft = readProgressDraft(value);
    if (draft && !draft.closed) updated[key] = {
      ...draft, closed: true, closed_reason: "plan_replaced", revision: draft.revision + 1, updated_at: new Date().toISOString(),
    };
  }
  return Object.keys(updated).length ? updated : null;
}

/** 편집이 건드리지 않은 요일은 새 플랜 세대에 묶고, 영향받은 요일만 닫는다. */
export function reconcileProgressDrafts(raw: unknown, generatedAt: string, affectedDays: number[] | null): Record<string, unknown> | null {
  if (!record(raw)) return null;
  const affected = affectedDays === null ? null : new Set(affectedDays.map(String));
  const updated: Record<string, unknown> = {};
  for (const [day, value] of Object.entries(raw)) {
    const draft = readProgressDraft(value);
    if (!draft || draft.closed) continue;
    if (affected === null || affected.has(day)) {
      updated[day] = { ...draft, closed: true, closed_reason: "plan_replaced",
        revision: draft.revision + 1, updated_at: new Date().toISOString() };
    } else if (draft.plan_generated_at !== generatedAt) {
      updated[day] = { ...draft, plan_generated_at: generatedAt };
    }
  }
  return Object.keys(updated).length ? updated : null;
}

/**
 * 요일 교환([D79]) — 두 날의 저장 기록(`sessions`)과 진행 초안(`progress_drafts`)을 **운동과 함께** 맞바꾼다.
 * 돌려주는 맵은 두 요일 키만 갖고, `null` 은 「그 필드를 지운다」다(한쪽에만 있던 것의 빈 자리).
 * - 옮겨 간 세션은 `day_index`·`date` 를 새 요일 것으로 다시 쓴다(D63 ② — 기록은 그 요일의 것).
 * - 초안은 종목 ID 키라 그대로 옮기고, 열린 초안만 `plan_generated_at` 을 새 플랜 시각으로 맞춘다. 옛 화면의 늦은 쓰기는
 *   편집이 새로 만든 `generated_at` 때문에 이미 `409 PLAN_CHANGED` 다 — revision 은 그대로 둔다.
 */
export function swapDayRecords(sessions: unknown, drafts: unknown, from: number, to: number, weekStart: string, generatedAt: string): {
  sessions: Record<string, unknown>; drafts: Record<string, unknown>;
} {
  const d = record(drafts) ? drafts : {};
  const moveDraft = (value: unknown) => {
    if (value === undefined) return null;
    const draft = readProgressDraft(value);
    return draft && !draft.closed ? { ...draft, plan_generated_at: generatedAt } : value;
  };
  const [a, b] = [String(from), String(to)];
  return {
    sessions: swapDaySessions(sessions, from, to, weekStart),
    drafts: { [b]: moveDraft(d[a]), [a]: moveDraft(d[b]) },
  };
}
