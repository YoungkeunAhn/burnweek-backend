/** Server-owned four-calendar-week prescription snapshot (ADR-0030). */

type Row = Record<string, unknown>;
const row = (value: unknown): Row | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const DAY = 86_400_000;

export function dateMillis(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return undefined;
  const ms = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === value ? ms : undefined;
}

export interface HistoryWeek { week_start_date?: string; sessions?: unknown }

/** Most recent usable session per exercise, never a maximum across weeks.
 * Empty/only-warmup entries do not hide an earlier performed working set.
 * Stored sessions are not mutated; selected copies retain their original date.
 */
export function recentPriorLogs(weeks: readonly HistoryWeek[], targetWeek: string): unknown[] {
  const target = dateMillis(targetWeek);
  if (target === undefined) return [];
  const candidates: Array<{ session: Row; exercises: Row[]; key: string }> = [];
  for (const week of weeks) {
    const start = dateMillis(week.week_start_date);
    if (start === undefined || start < target - 28 * DAY || start >= target) continue;
    const sessions = Object.entries(row(week.sessions) ?? {}).sort(([a], [b]) => Number(a) - Number(b));
    for (const [index, [, raw]] of sessions.entries()) {
      const session = row(raw);
      if (!session || !Array.isArray(session.exercises)) continue;
      // Legacy undated sessions use their owning week and day, never today's date.
      const day = Number.isInteger(session.day_index) && Number(session.day_index) >= 0 && Number(session.day_index) <= 6
        ? Number(session.day_index) : 0;
      const date = session.date === undefined ? new Date(start + day * DAY).toISOString().slice(0, 10) : session.date;
      const performed = dateMillis(date);
      if (performed === undefined || performed < start || performed >= start + 7 * DAY || performed >= target) continue;
      const exercises = session.exercises.map(row).filter((ex): ex is Row => !!ex && typeof ex.exercise_id === "string" && Array.isArray(ex.sets) && ex.sets.some((rawSet) => {
        const set = row(rawSet);
        if (!set || set.set_kind === "warmup") return false;
        if (row(set.cardio)) return true;
        return (typeof set.actual_reps === "number" && Number.isFinite(set.actual_reps) && set.actual_reps >= 0
          && typeof set.actual_load_kg === "number" && Number.isFinite(set.actual_load_kg) && set.actual_load_kg >= 0)
          || (typeof set.actual_seconds === "number" && Number.isFinite(set.actual_seconds) && set.actual_seconds > 0);
      }));
      candidates.push({ session: { ...session, date }, exercises, key: `${date}|${day}|${week.week_start_date}|${index.toString().padStart(2, "0")}` });
    }
  }
  const seen = new Set<string>();
  const selected: Row[] = [];
  for (const { session, exercises } of candidates.sort((a, b) => b.key.localeCompare(a.key))) {
    const keep = exercises.filter((ex) => {
      const id = ex.exercise_id as string;
      if (seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (keep.length) selected.push({ ...session, exercises: keep });
  }
  return selected.reverse();
}

export function priorPerformedDate(exerciseId: string, logs: unknown[]): string | undefined {
  let latest: string | undefined;
  for (const raw of logs) {
    const session = row(raw);
    if (!session || dateMillis(session.date) === undefined || !Array.isArray(session.exercises)) continue;
    if (session.exercises.some((ex) => row(ex)?.exercise_id === exerciseId)) {
      const date = session.date as string;
      if (!latest || date > latest) latest = date;
    }
  }
  return latest;
}

/** Undated legacy snapshots retain their existing behavior; new snapshots are dated. */
export function hasHistoryGap(exerciseId: string, logs: unknown[], targetWeek?: string): boolean {
  const target = dateMillis(targetWeek);
  const performed = dateMillis(priorPerformedDate(exerciseId, logs));
  return target !== undefined && performed !== undefined && performed < target - 7 * DAY;
}
