/**
 * Weekly quota arithmetic (계약 §오류 코드 429). The endpoint-level behaviour lives
 * in `generation-api-contract.test.ts`; what only a unit test can reach is the
 * week rollover — the endpoint tests cannot move the clock.
 */
import { describe, expect, it } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { WEEKLY_GENERATION_LIMIT, countGeneration, weekStartUtc } from "../src/rate-limit";

/** Minimal Firestore stand-in: one map, transactions applied immediately. */
function fakeDb() {
  const docs = new Map<string, Record<string, unknown>>();
  const ref = (id: string) => ({ id });
  const db = {
    docs,
    collection: () => ({ doc: ref }),
    runTransaction: (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        get: (r: { id: string }) =>
          Promise.resolve({ exists: docs.has(r.id), data: () => docs.get(r.id) }),
        set: (r: { id: string }, data: Record<string, unknown>) => void docs.set(r.id, { ...data }),
      }),
  };
  return db as unknown as Firestore & { docs: Map<string, Record<string, unknown>> };
}

describe("weekStartUtc", () => {
  it("returns the Monday of the week for every day", () => {
    // 2026-08-17 is a Monday; the whole week must map to it.
    const week = [
      "2026-08-17T00:00:00Z", // Mon
      "2026-08-19T13:45:00Z", // Wed
      "2026-08-23T23:59:59Z", // Sun
    ];
    for (const iso of week) expect(weekStartUtc(new Date(iso)), iso).toBe("2026-08-17");
  });

  it("rolls over on Monday, not Sunday", () => {
    expect(weekStartUtc(new Date("2026-08-23T23:59:59Z"))).toBe("2026-08-17"); // Sunday night
    expect(weekStartUtc(new Date("2026-08-24T00:00:00Z"))).toBe("2026-08-24"); // Monday
  });
});

describe("countGeneration", () => {
  const monday = new Date("2026-08-17T10:00:00Z");

  it("allows exactly the weekly allowance, then refuses", async () => {
    const db = fakeDb();
    for (let i = 1; i <= WEEKLY_GENERATION_LIMIT; i++) {
      const decision = await countGeneration(db, "u1", monday);
      expect(decision.allowed).toBe(true);
      expect(decision.count).toBe(i);
    }
    const refused = await countGeneration(db, "u1", monday);
    expect(refused.allowed).toBe(false);
    expect(refused.count).toBe(WEEKLY_GENERATION_LIMIT); // refusal does not increment
    expect(refused.resetsOn).toBe("2026-08-24");
  });

  it("refills in the next week instead of carrying the tally over", async () => {
    const db = fakeDb();
    for (let i = 0; i < WEEKLY_GENERATION_LIMIT; i++) await countGeneration(db, "u1", monday);
    expect((await countGeneration(db, "u1", monday)).allowed).toBe(false);

    const nextWeek = new Date("2026-08-24T00:00:01Z");
    const decision = await countGeneration(db, "u1", nextWeek);
    expect(decision.allowed).toBe(true);
    expect(decision.count).toBe(1);
    expect(decision.windowStart).toBe("2026-08-24");
  });

  it("keeps separate counters per user", async () => {
    const db = fakeDb();
    for (let i = 0; i < WEEKLY_GENERATION_LIMIT; i++) await countGeneration(db, "u1", monday);
    expect((await countGeneration(db, "u2", monday)).allowed).toBe(true);
  });

  it("stores a counter and nothing else (NFR-PRIV-1)", async () => {
    const db = fakeDb();
    await countGeneration(db, "u1", monday);
    const stored = db.docs.get("u1")!;
    expect(Object.keys(stored).sort()).toEqual(["count", "expires_at", "uid", "week_start"]);
    // TTL field must be in the future so the policy can reclaim stale counters.
    // TTL 필드는 Date(→Timestamp)여야 한다 — 문자열이면 정책이 못 읽는다.
    expect(stored.expires_at).toBeInstanceOf(Date);
    expect((stored.expires_at as Date).getTime()).toBeGreaterThan(monday.getTime());
  });

  it("honours a caller-supplied limit", async () => {
    const db = fakeDb();
    expect((await countGeneration(db, "u1", monday, 1)).allowed).toBe(true);
    expect((await countGeneration(db, "u1", monday, 1)).allowed).toBe(false);
  });
});
