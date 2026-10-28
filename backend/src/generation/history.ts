/**
 * 종목 이력 집계 — `GET /v1/plans/history?exercise_id=` (백로그 025 §2 · D35).
 *
 * **Firestore 를 모르는 순수함수다.** 호출 층(`index.ts`·`dev-server.mjs`)은 주차
 * 문서를 읽어 그대로 넘기기만 한다 — D35 가 *"나중에 `/v1/exercises/**` 로 옮기고
 * 싶어지면 핸들러 배선과 rewrite 한 줄만 바꾸면 된다"* 고 적어 둔 것이 이 경계에
 * 걸려 있다. `edit.ts`·`session.ts` 와 같은 구조다.
 *
 * 025 §2 의 규칙표가 정본이고, 이 파일은 그것을 그대로 옮긴 것이다.
 */
import { estimateE1rm } from "./loading";
import type { SavedWeek } from "./edit";

/**
 * `weeks` 기본·상한(025 §2). 주차 완료 요약(계약 §2.6 — 기본 12·상한 26)과 **다른
 * 축이다**: 이쪽은 "역대"를 흉내내야 해서 더 멀리 본다.
 */
export const EXERCISE_HISTORY_DEFAULT_WEEKS = 26;
export const EXERCISE_HISTORY_MAX_WEEKS = 52;

/**
 * `weeks` 질의값 → `1..max` 정수. 숫자가 아니면 기본값이다.
 *
 * **호출 층은 이 값을 Firestore `limit()` 에 그대로 넣어야 한다** — 여기서만 자르고
 * 질의를 안 자르면 상한이 선언일 뿐이고 문서 읽기는 그대로 는다(025 §2 가 상한을
 * 둔 이유가 읽기 비용이다).
 */
export function clampWeeks(raw: unknown, dflt: number, max: number): number {
  const asked = Number(raw ?? dflt);
  return Number.isFinite(asked) ? Math.min(Math.max(Math.trunc(asked), 1), max) : dflt;
}

/** 한 주의 그 종목 기록. 값이 없는 주는 아예 만들어지지 않는다(`null` 이 되지 `0` 이 되지 않는다). */
export interface ExerciseWeekStat {
  week_start_date: string;
  top_load_kg: number;
  top_reps: number;
  one_rm_kg: number;
  volume_kg: number;
}

/** 그 종목을 마지막으로 한 주의 유산소 기록(041 N6 · [D57] A10). 근력 종목에는 아예 없다. */
export interface ExerciseWeekCardio {
  week_start_date: string;
  /** 저장된 `cardio` 한 벌 그대로 — 화면이 입력 칸으로 되돌린다(041 N7). */
  cardio: Record<string, unknown>;
}

export interface ExerciseHistory {
  /**
   * **그 종목을 마지막으로 한 주 — 단 이번 주는 뺀다.** "지난주"가 아니다(격주로
   * 하는 종목은 지난주에 없다). 이번 주를 빼는 이유는 `exerciseHistory` 주석에 있다.
   */
  previous: ExerciseWeekStat | null;
  /** 구간 안의 **항목별 최대**. **이번 주를 포함한다.** `exerciseHistory` 주석 참고. */
  best: ExerciseWeekStat | null;
  /**
   * 유산소 기록(041 N6 · G0 Q9). `previous` 와 **같은 규칙**이다 — 마지막으로 한 주이고 이번 주는 뺀다.
   * 유산소 기록이 하나도 없으면 아예 싣지 않는다(근력 종목의 응답은 한 필드도 안 바뀐다 — T6-9).
   */
  previous_cardio?: ExerciseWeekCardio;
}

/** 미니앱 `exerciseStats` 와 같은 반올림. 두 화면이 같은 값을 보여야 비교가 성립한다. */
const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * 한 주 문서에서 그 종목의 워킹 세트만 모아 집계한다. 세트가 하나도 없으면 `null`
 * — 그 주는 "그 종목을 한 주"가 아니다.
 *
 * **미니앱 `exerciseStats`(`session.tsx`)와 같은 식이어야 한다.** 1RM 은 백엔드가
 * 처방에 쓰는 것과 **같은 함수**(`estimateE1rm`, Epley)를 부른다 — 복사하면 언젠가
 * 갈리고, 갈리는 순간 `이전 65.5` 와 `지금 70` 이 비교 불가능한 두 숫자가 된다
 * (025 §2). `check.mjs` 가 두 쪽을 같이 불러 이 일치를 단정한다.
 */
function statOf(week: SavedWeek, exerciseId: string): ExerciseWeekStat | null {
  const sessions = week.sessions;
  if (!sessions || typeof sessions !== "object") return null;

  let topKg = -1, topReps = 0, oneRm = 0, volume = 0, sets = 0;
  for (const session of Object.values(sessions)) {
    const exercises = (session as { exercises?: unknown } | null)?.exercises;
    // 모양을 믿지 않는다 — 이 컬렉션에는 계약이 지금과 달랐던 시절의 문서가 남아
    // 있다(`weekHistory` 가 같은 방어를 하는 이유, cursor 교차검증 2026-08-28).
    if (!Array.isArray(exercises)) continue;
    for (const ex of exercises as Array<{ exercise_id?: unknown; sets?: unknown }>) {
      if (ex?.exercise_id !== exerciseId) continue;
      if (!Array.isArray(ex.sets)) continue;
      for (const set of ex.sets as Array<Record<string, unknown>>) {
        // **워킹 세트만**(025 §2) — 웜업은 기록 대상이 아니다. 화면의 `workingSets` 와 같은 기준.
        if (set?.set_kind !== "working") continue;
        const reps = set.actual_reps;
        const kg = set.actual_load_kg;
        // 유산소 세트는 `cardio` 만 있고 이 둘이 없다 — 여기서 걸러진다.
        if (typeof reps !== "number" || !Number.isFinite(reps)) continue;
        if (typeof kg !== "number" || !Number.isFinite(kg)) continue;
        // **0회는 한 세트가 아니다.** 스키마가 `actual_reps: 0` 을 허용하고(체크한
        // 뒤 회수를 0 으로 적으면 그대로 저장된다) Epley 는 거기서 정의되지 않는다
        // (`estimateE1rm` 이 `undefined` 를 주는 이유). 세면 `50kg × 0회` 가
        // `최고 1RM 50kg` 으로 읽힌다 — 들지도 않은 무게가 기록이 된다.
        // (맨몸 `0kg` 은 다르다 — 그건 실제로 한 세트라 볼륨 0 으로 든다.)
        if (reps <= 0) continue;
        sets += 1;
        volume += kg * reps;
        // 맨몸(0kg)은 `estimateE1rm` 이 `undefined` 다 — 0 으로 읽어 `exerciseStats`
        // 의 `kg * (1 + reps/30)` = 0 과 같은 값이 된다.
        oneRm = Math.max(oneRm, estimateE1rm(reps, kg) ?? 0);
        // 같은 무게면 더 많이 한 세트가 위다 — `50x12` 와 `50x11` 중 앞의 것.
        if (kg > topKg || (kg === topKg && reps > topReps)) { topKg = kg; topReps = reps; }
      }
    }
  }
  if (sets === 0) return null;
  return {
    week_start_date: week.week_start_date ?? "",
    top_load_kg: topKg,
    top_reps: topReps,
    one_rm_kg: round1(oneRm),
    // **볼륨은 여기서 반올림하지 않는다.** 화면은 같은 세션의 볼륨을 원값으로
    // 들고 표시할 때만 깎는데(`session.tsx` `volumeIn`), 서버만 정수 kg 로 먼저
    // 깎으면 **같은 기록이 두 줄에서 다른 숫자로 보인다** — `100lb × 1` 이 지금
    // 값은 `100lb`, `이전` 은 `99lb` 다(codex 교차검증 2026-09-01). 무게가
    // 소수(45.359237kg = 100lb)일 수 있으므로 합계도 소수인 것이 자연스럽다.
    volume_kg: volume,
  };
}

/**
 * `previous`(그 종목을 마지막으로 한 주) · `best`(구간 최고). 없으면 **`null` 이지
 * `0` 이 아니다** — 처음 하는 종목에 `이전 0kg` 이 뜨면 거짓이다(025 §2).
 *
 * **`currentWeek` 이 있으면 `previous` 에서 그 주(와 그 뒤)를 뺀다. `best` 는 뺀
 * 것이 없다**(025 §2 · 2026-08-31 G4). 안 빼면 오늘 `운동 완료` 를 누른 뒤
 * `이전` 줄이 **방금 내가 한 값**이 되어 증감 화살표가 두 번째 방문부터 항상 `=`
 * 다 — 기능이 통째로 무의미해진다. `best` 는 반대다: 오늘 세운 기록도 기록이라
 * 빼면 PR 이 한 주 늦게 뜬다.
 *
 * **`currentWeek` 은 호출자가 준다** — "이번 주"는 사용자의 로컬 달력 기준이고
 * (D22-3) 서버는 그 시간대를 모른다. 가장 최신 문서를 이번 주로 치는 방법도 있지만,
 * 이번 주 플랜을 아직 안 만들었으면 그게 지난주라 **지난주가 통째로 빠진다.**
 * 비어 있으면 아무것도 빼지 않는다.
 *
 * **`best` 는 항목별 최대다.** 025 §2 의 예시 세 줄이 그렇게 읽힌다 — `최고 82.5 × 15`
 * 의 Epley 는 123.75 인데 같은 줄의 `최고 1RM` 은 122.4 다. 즉 세 값이 한 주에서
 * 같이 나온 것이 아니다. `week_start_date` 는 **`top_load_kg` 이 나온 주**다(세 값의
 * 주가 다를 수 있어 대표 하나를 고른 것이고, 계약 §2.6 에 그렇게 적었다).
 * `top_load_kg` 와 `top_reps` 는 **한 세트의 쌍이라 같이 움직인다** — 무게만 최대를
 * 취하고 회수를 다른 주에서 가져오면 하지도 않은 `82.5 × 20` 이 만들어진다.
 */
/**
 * 한 주 문서에서 그 종목의 **마지막 유산소 기록**. 없으면 `null`.
 *
 * `statOf` 와 나란히 두되 섞지 않는다 — 유산소 세트에는 무게도 회수도 없어 `top_load_kg` 가 `0` 으로
 * 뜬다(T6-7). 같은 주에 두 번 했으면 요일이 늦은 쪽이다(생성의 `cardioTargetFromPriorLogs` 와 같은 기준).
 */
function cardioOf(week: SavedWeek, exerciseId: string): Record<string, unknown> | null {
  const sessions = week.sessions;
  if (!sessions || typeof sessions !== "object") return null;
  let best: { key: string; cardio: Record<string, unknown> } | undefined;
  for (const [key, raw] of Object.entries(sessions)) {
    const session = raw as { date?: unknown; day_index?: unknown; exercises?: unknown } | null;
    const exercises = session?.exercises;
    if (!Array.isArray(exercises)) continue;
    const order = [
      typeof session?.date === "string" ? session.date : "",
      String(typeof session?.day_index === "number" ? session.day_index : Number(key) || -1).padStart(3, "0"),
    ].join("|");
    for (const ex of exercises as Array<{ exercise_id?: unknown; sets?: unknown }>) {
      if (ex?.exercise_id !== exerciseId || !Array.isArray(ex.sets)) continue;
      for (const set of ex.sets as Array<Record<string, unknown>>) {
        const cardio = set?.cardio;
        if (!cardio || typeof cardio !== "object") continue;
        if (!best || order > best.key) best = { key: order, cardio: cardio as Record<string, unknown> };
      }
    }
  }
  return best?.cardio ?? null;
}

export function exerciseHistory(
  weeks: SavedWeek[],
  exerciseId: string,
  limit: number,
  currentWeek = "",
): ExerciseHistory {
  if (!exerciseId) return { previous: null, best: null };

  const scanned = weeks
    .filter((w): w is SavedWeek => !!w && typeof w === "object")
    // 주 시작일 역순 = 최신순. 호출 층의 정렬을 믿지 않는다 — `previous` 가 "마지막으로
    // 한 주"인지가 이 한 줄에 걸려 있어, 순서를 남에게 맡기면 조용히 틀린다.
    .sort((a, b) => (b.week_start_date ?? "").localeCompare(a.week_start_date ?? ""))
    .slice(0, Math.max(Math.trunc(limit), 0));
  const stats = scanned
    .map((w) => statOf(w, exerciseId))
    .filter((s): s is ExerciseWeekStat => s !== null);

  // 유산소는 근력과 **따로 센다**(041 N6 · T6-7) — 유산소만 한 종목은 `stats` 가 비어 있어
  // 아래 조기 반환에 걸린다. 이번 주를 빼는 규칙은 `previous` 와 같다(§2.6.1 🔴 — 안 빼면
  // 방금 한 값이 「지난 기록」이 된다). 최신순이라 처음 걸리는 주가 마지막으로 한 주다.
  const previousCardio = scanned
    .filter((w) => !currentWeek || (w.week_start_date ?? "") < currentWeek)
    .map((w) => ({ week_start_date: w.week_start_date ?? "", cardio: cardioOf(w, exerciseId) }))
    .find((x): x is ExerciseWeekCardio => x.cardio !== null);
  // 근력 종목의 응답은 한 필드도 바뀌지 않는다(T6-9) — 없으면 키 자체를 안 싣는다.
  const withCardio = previousCardio ? { previous_cardio: previousCardio } : {};

  if (stats.length === 0) return { previous: null, best: null, ...withCardio };

  // 최신순이므로 **이번 주보다 앞선 첫 항목**이 "마지막으로 한 주"다.
  // `best` 는 아래에서 `stats` 전체를 보므로 이번 주가 그대로 든다.
  const previous = stats.find((s) => !currentWeek || s.week_start_date < currentWeek) ?? null;
  // `top_load_kg` 최대 → 동률이면 회수가 많은 쪽 → 그래도 동률이면 최신(최신순 스캔이라 먼저 잡힌 것이 남는다).
  const topWeek = stats.reduce((a, b) =>
    b.top_load_kg > a.top_load_kg || (b.top_load_kg === a.top_load_kg && b.top_reps > a.top_reps) ? b : a);
  return {
    ...withCardio,
    previous,
    best: {
      week_start_date: topWeek.week_start_date,
      top_load_kg: topWeek.top_load_kg,
      top_reps: topWeek.top_reps,
      one_rm_kg: Math.max(...stats.map((s) => s.one_rm_kg)),
      volume_kg: Math.max(...stats.map((s) => s.volume_kg)),
    },
  };
}

/** 성장 비교의 한 주 값 — `statOf` 와 같은 값에서 주 날짜만 뺀 것(주는 응답 머리가 든다). */
export type GrowthWeekStat = Omit<ExerciseWeekStat, "week_start_date">;
export interface GrowthExercise { exercise_id: string; previous: GrowthWeekStat; current: GrowthWeekStat }
export interface GrowthTrend { week_start_date: string; previous_week: string; exercises: GrowthExercise[] }

/** 실제 달력 날짜인 `YYYY-MM-DD` 인가 — 정규식만 보면 `2026-13-01` 이 통과해 뒤에서 500 이 난다(codex N1 R1). */
export function isCalendarDate(s: unknown): s is string {
  if (typeof s !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** `YYYY-MM-DD` 의 7일 전. UTC 로만 계산해 서버 시간대와 무관하다. */
export function previousWeekOf(weekStart: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 7);
  return d.toISOString().slice(0, 10);
}

/**
 * 성장 비교 — 계약 §2.6.2 · D90. **이번 주 문서와 그 7일 전 문서**를 받는다(「가장 최근 두 문서」가
 * 아니다 — 띄엄띄엄 기록하면 3주 전과 비교하게 된다). 두 주 모두에 워킹 세트가 있는 종목만 싣는다.
 * 판정(반올림·성장 여부·부위)은 화면이 한다 — 서버는 `statOf` 값을 그대로 준다.
 */
export function growthTrend(current: SavedWeek | null, previous: SavedWeek | null, weekStart: string): GrowthTrend {
  const ids = new Set<string>();
  for (const session of Object.values(current?.sessions ?? {})) {
    const exercises = (session as { exercises?: unknown } | null)?.exercises;
    if (!Array.isArray(exercises)) continue;
    for (const ex of exercises as Array<{ exercise_id?: unknown }>) if (typeof ex?.exercise_id === "string") ids.add(ex.exercise_id);
  }
  const strip = ({ week_start_date: _, ...rest }: ExerciseWeekStat): GrowthWeekStat => rest;
  const exercises: GrowthExercise[] = [];
  for (const id of ids) {
    const now = current ? statOf(current, id) : null;
    const before = previous ? statOf(previous, id) : null;
    if (now && before) exercises.push({ exercise_id: id, previous: strip(before), current: strip(now) });
  }
  return { week_start_date: weekStart, previous_week: previousWeekOf(weekStart), exercises };
}
