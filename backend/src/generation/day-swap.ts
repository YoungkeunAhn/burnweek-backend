/**
 * 요일 교환([D79])의 기록 쪽 — 의존성 없는 순수 함수라 미니앱도 같은 것을 import 한다(화면의 `sessions` 를 서버와 같은 규칙으로 옮긴다).
 * 두 날의 저장 기록을 맞바꾸고 옮겨 간 기록의 `day_index`·`date` 를 새 요일 것으로 다시 쓴다(D63 ② — 기록은 그 요일의 것).
 * 돌려주는 맵은 두 요일 키만 갖고 `null` 은 「그 자리를 지운다」다.
 */
export function swapDaySessions(sessions: unknown, from: number, to: number, weekStart: string): Record<string, unknown> {
  const s = sessions && typeof sessions === "object" && !Array.isArray(sessions) ? sessions as Record<string, unknown> : {};
  const move = (value: unknown, day: number) =>
    value && typeof value === "object" && !Array.isArray(value) ? { ...value, day_index: day, date: dayOf(weekStart, day) } : null;
  return { [String(to)]: move(s[String(from)], to), [String(from)]: move(s[String(to)], from) };
}

/** `YYYY-MM-DD` + n일. UTC 로 세어 시간대에 흔들리지 않는다. */
function dayOf(weekStart: string, dayIndex: number): string {
  const [y, m, d] = weekStart.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + dayIndex)).toISOString().slice(0, 10);
}
