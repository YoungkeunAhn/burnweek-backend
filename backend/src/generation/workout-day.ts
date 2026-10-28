/**
 * 운동일 아침 푸시의 판정 — 계약 §2.8 · D90. Firestore 를 모르는 순수함수다(`history.ts` 와 같은 경계).
 */

/** 서울 날짜(`YYYY-MM-DD`). 한국은 서머타임이 없어 +9시간이 곧 KST 다 — 서버 UTC 로 오늘을 정하면 00–09시에 하루 밀린다. */
export function seoulToday(now: Date): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 그 날짜가 속한 주의 월요일(`YYYY-MM-DD`) — 주차 문서 id 와 같은 규칙(D22-3 · 월요일 시작). */
export function mondayOf(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * 오늘 보낼 `focus`. 오늘이 그 주 안이고 · 휴식일이 아니고 · 종목이 있으면 그날 `focus`, 아니면 `null`(보내지 않는다).
 * `week` 는 희소 배열일 수 있다 — `day_index` 로 찾는다.
 */
export function workoutDayFocus(weekDoc: { week_start_date?: string; plan?: unknown } | null, today: string): string | null {
  if (!weekDoc?.week_start_date) return null;
  const index = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${weekDoc.week_start_date}T00:00:00Z`)) / 86_400_000);
  if (!(index >= 0 && index <= 6)) return null;
  const raw = (weekDoc.plan as { week?: unknown } | undefined)?.week;
  const days = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : [];
  const day = days.find((d) => d?.day_index === index);
  if (!day || day.session_type === "rest") return null;
  if (!Array.isArray(day.exercises) || day.exercises.length === 0) return null;
  return typeof day.focus === "string" && day.focus.trim() ? day.focus.trim() : null;
}
