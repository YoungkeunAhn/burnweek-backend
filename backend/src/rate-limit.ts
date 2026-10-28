/**
 * Per-user generation quota (계약 §오류 코드 `429`, NFR-COST-1 / D8 비용 통제).
 *
 * Authentication (T5.5) stops strangers from spending our LLM budget; this stops
 * one authenticated user from spending it in a loop. It is the last uncapped path
 * to real money — Firebase itself stays inside the free tier
 * (docs/research/07-backend-cost-and-free-tier.md).
 *
 * **What is stored:** `{ uid, week_start, count, expires_at }` and nothing else —
 * no profile, no logs, no plan. That is a counter, not user history, so it does
 * not turn the backend into a permanent store. (미니앱은 D19로 Firestore 정본을
 * 갖게 되지만 그건 별도 컬렉션이다 — 레이트리밋 문서는 계속 카운터뿐이다.) `expires_at`
 * lets the TTL policy remove counters of users who stop coming back.
 */
import type { Firestore, Transaction } from "firebase-admin/firestore";

export const RATE_LIMITS = "rate_limits";

/**
 * Generations allowed per user per week. The product plans **one** regular
 * generation a week (NFR-COST-1), but a hard limit of 1 would let a single LLM
 * outage cost the user their whole week: the attempt is counted at intake, long
 * before we know whether the model answered. Three leaves room for two retries.
 */
export const WEEKLY_GENERATION_LIMIT = 3;

/** How long a counter outlives its window before the TTL policy removes it. */
const COUNTER_TTL_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Monday of `now`'s week, in UTC, as `YYYY-MM-DD`.
 *
 * The window is server-side on purpose: keying it on the request's
 * `week_start_date` would let a caller reset their own quota by sending a
 * different week. UTC (not KST) means the window opens Monday 09:00 KST — that
 * only ever gives a Korean user *more* room in a fresh calendar week, never less.
 */
export function weekStartUtc(now: Date): string {
  const daysSinceMonday = (now.getUTCDay() + 6) % 7;
  const monday = new Date(now.getTime() - daysSinceMonday * DAY_MS);
  return monday.toISOString().slice(0, 10);
}

/** TTL 필드로 쓰이므로 **`Date`** 를 준다 — 문자열이면 Firestore TTL 정책이 못 읽는다. */
function addDays(isoDate: string, days: number): Date {
  return new Date(Date.parse(`${isoDate}T00:00:00Z`) + days * DAY_MS);
}

export interface QuotaDecision {
  allowed: boolean;
  /** Generations used in this window, including the one just counted. */
  count: number;
  limit: number;
  /** `YYYY-MM-DD` Monday the window opened. */
  windowStart: string;
  /** `YYYY-MM-DD` the quota refills. */
  resetsOn: string;
}

/**
 * Counts one generation attempt for `uid`, or refuses it. Runs in a transaction
 * so two requests racing cannot both read the same count and both pass.
 */
export async function countGeneration(
  db: Firestore,
  uid: string,
  now: Date,
  limit = WEEKLY_GENERATION_LIMIT,
  guard?: (tx: Transaction) => Promise<void>,
): Promise<QuotaDecision> {
  const ref = db.collection(RATE_LIMITS).doc(uid);
  const windowStart = weekStartUtc(now);
  const resetsOn = addDays(windowStart, 7).toISOString().slice(0, 10);

  return db.runTransaction(async (tx) => {
    await guard?.(tx);
    const snap = await tx.get(ref);
    const stored = snap.exists ? (snap.data() as { week_start?: string; count?: number }) : undefined;
    // A counter from an earlier week is stale, not a tally: start over.
    const used = stored?.week_start === windowStart ? Number(stored.count ?? 0) : 0;

    if (used >= limit) return { allowed: false, count: used, limit, windowStart, resetsOn };

    tx.set(ref, {
      uid,
      week_start: windowStart,
      count: used + 1,
      expires_at: addDays(windowStart, COUNTER_TTL_DAYS),
    });
    return { allowed: true, count: used + 1, limit, windowStart, resetsOn };
  });
}
