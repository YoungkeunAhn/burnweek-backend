import { describe, expect, it } from "vitest";
import { CIRCUIT_TEMPLATES, JUMP_MOVES, circuitTemplateFor, expandCircuit } from "../src/data/circuits";
import { byId } from "../src/data/exercises";
import { applyEdit, savedHasCircuit } from "../src/generation/edit";
import { expandDraftToWeeklyPlan } from "../src/generation/expand";
import { generatedPlanExerciseProblems } from "../src/generation/exercise-policy";
import { MEDICAL_DISCLAIMER } from "../src/generation/safety";
import type { UserProfile } from "../src/generation/types";
import { checkPerformedSession, checkWeeklyPlan } from "../src/schemas/validate";

// 서킷 계약·백엔드(실행 그래프 N7a · D101 ④ · D102 · 백로그 운동목록 11).

function profile(overrides: Partial<UserProfile> = {}): UserProfile {
  return {
    goals: ["lose_fat"],
    experience_level: "beginner",
    days_per_week: 3,
    session_len_min: 45,
    environment: "bodyweight_only",
    equipment: [],
    cardio_pref: "maintain_health",
    cardio_modalities: [],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}

const DRAFT = {
  schema_version: "1.0",
  split_type: "full_body",
  week: [0, 2, 4].map((day_index) => ({
    day_index,
    session_type: "lift",
    focus: "",
    items: [
      { kind: "strength", exercise_id: "bodyweight_squat", role: "primary", order: 1, rep_intent: "hypertrophy" },
      { kind: "strength", exercise_id: "pushups", role: "secondary", order: 2, rep_intent: "hypertrophy" },
      { kind: "strength", exercise_id: "table_inverted_row", role: "secondary", order: 3, rep_intent: "hypertrophy" },
    ],
  })),
};

function expand(opts: { circuits?: boolean; profile?: UserProfile; draft?: unknown } = {}) {
  return expandDraftToWeeklyPlan({
    draft: opts.draft ?? DRAFT,
    profile: opts.profile ?? profile(),
    userId: "u1",
    weekStartDate: "2026-08-17",
    weekNumber: 1,
    priorLogs: [],
    disclaimer: MEDICAL_DISCLAIMER,
    source: "ai",
    ...(opts.circuits !== undefined ? { circuits: opts.circuits } : {}),
  });
}

type Row = { exercise_id: string; modality: string; order: number; circuit?: { id: string; format: string; rounds: number; name: string; source_url: string }; sets?: Array<Record<string, unknown>> };
const rows = (plan: unknown) => (plan as { week: Array<{ day_index: number; exercises: Row[] }> }).week;

describe("서킷 생성 (T7-1 · T7-2 · T7-5)", () => {
  it("T7-1 맨몸·감량 + 플래그 → 유산소 자리에 서킷, 스키마·값 규칙 통과, 같은 서킷 id 안 order 중복 없음", () => {
    const out = expand({ circuits: true });
    expect(out.problems).toEqual([]);
    expect(checkWeeklyPlan(out.plan).ok).toBe(true);
    for (const day of rows(out.plan)) {
      expect(day.exercises.some((e) => e.modality === "cardio")).toBe(false);
      const circuit = day.exercises.filter((e) => e.circuit);
      expect(circuit.length).toBeGreaterThan(0);
      expect(new Set(circuit.map((e) => e.circuit!.id)).size).toBe(1);
      const orders = day.exercises.map((e) => e.order);
      expect(new Set(orders).size).toBe(orders.length);
      // 서킷은 근력 뒤.
      const firstCircuit = day.exercises.findIndex((e) => e.circuit);
      expect(day.exercises.slice(firstCircuit).every((e) => e.circuit)).toBe(true);
    }
    // 생성 최종 검사: 서킷 동작은 LLM 후보 밖이어도 문제 아님.
    expect(generatedPlanExerciseProblems(out.plan, profile(), ["bodyweight_squat", "pushups", "table_inverted_row"])).toEqual([]);
  });

  it("T7-2 A 는 target_seconds(렙 없음), B·C 는 렙", () => {
    const week = rows(expand({ circuits: true, profile: profile({ experience_level: "novice_intermediate" }) }).plan);
    const byFormat = (f: string) => week.flatMap((d) => d.exercises.filter((e) => e.circuit?.format === f));
    for (const e of byFormat("A")) for (const s of e.sets!) {
      expect(s.target_seconds).toBeGreaterThan(0);
      expect(s.target_reps_low).toBeUndefined();
    }
    for (const f of ["B", "C"]) for (const e of byFormat(f)) for (const s of e.sets!) {
      expect(s.target_reps_low).toBeGreaterThan(0);
      expect(s.target_seconds).toBeUndefined();
    }
    // 중급 3회면 A → C → B 가 한 번씩.
    expect(new Set(week.map((d) => d.exercises.find((e) => e.circuit)!.circuit!.format))).toEqual(new Set(["A", "B", "C"]));
  });

  it("T7-5 플래그 꺼짐 · 서킷 추천이 아닌 사용자 · 그 날 유산소를 편집한 날은 서킷 없음", () => {
    expect(rows(expand().plan).flatMap((d) => d.exercises).some((e) => e.circuit)).toBe(false);
    expect(rows(expand({ circuits: true, profile: profile({ goals: ["build_muscle"] }) }).plan).flatMap((d) => d.exercises).some((e) => e.circuit)).toBe(false);
    const draft = structuredClone(DRAFT) as { week: Array<Record<string, unknown>> };
    draft.week[0]!.cardio_override = "none";
    draft.week[1]!.cardio_override = { exercise_id: "trail_running_walking" };
    const week = rows(expand({ circuits: true, draft }).plan);
    expect(week.find((d) => d.day_index === 0)!.exercises.some((e) => e.circuit)).toBe(false);
    // 그 날 유산소를 사용자가 직접 고른 날은 그 유산소 그대로, 서킷 아님.
    const day2 = week.find((d) => d.day_index === 2)!.exercises;
    expect(day2.some((e) => e.circuit)).toBe(false);
    expect(day2.some((e) => e.exercise_id === "trail_running_walking")).toBe(true);
  });

  it("편집 재확장은 저장된 주에 서킷이 있었으면 서킷을 유지한다", () => {
    const out = expand({ circuits: true });
    expect(savedHasCircuit({ plan: out.plan } as never)).toBe(true);
    expect(savedHasCircuit({ plan: expand().plan } as never)).toBe(false);
    const edited = applyEdit(DRAFT, { op: "remove", day_index: 0, exercise_id: "pushups" });
    expect("draft" in edited).toBe(true);
  });
});

describe("템플릿 (T7-2b · T7-4)", () => {
  it("T7-2b 다섯 템플릿 모두 입문 버전 — 점프 동작 0, B1 입문 렙 < 원본, 카탈로그에 있는 동작만", () => {
    expect(CIRCUIT_TEMPLATES.map((t) => t.id)).toEqual(["A1", "A2", "B1", "C1", "C2"]);
    for (const t of CIRCUIT_TEMPLATES) {
      const beginner = expandCircuit(t, true);
      expect(beginner.filter((m) => JUMP_MOVES.has(m.exercise_id)), t.id).toEqual([]);
      for (const m of [...beginner, ...expandCircuit(t, false)]) expect(byId(m.exercise_id), m.exercise_id).toBeDefined();
    }
    const b1 = CIRCUIT_TEMPLATES.find((t) => t.id === "B1")!;
    const total = (moves: ReturnType<typeof expandCircuit>) => moves.flatMap((m) => m.sets).reduce((s, x) => s + ("reps" in x ? x.reps : 0), 0);
    expect(total(expandCircuit(b1, true))).toBeLessThan(total(expandCircuit(b1, false)));
    expect(total(expandCircuit(b1, false))).toBe(450);
  });

  it("T7-4 이름에 채널·브랜드 이름 없음 · 출처 링크 있음", () => {
    for (const t of CIRCUIT_TEMPLATES) {
      expect(t.name).not.toMatch(/땅끄|땅크|빅씨스|Freeletics|Scientific|칼소폭|피지컬|부부/i);
      expect(t.source_url).toMatch(/^https:\/\//);
    }
  });

  it("입문 회전은 A·C 만(D102 ② — B 는 중급 이상)", () => {
    const beginner = [0, 1, 2, 3, 4].map((n) => circuitTemplateFor(["A"], n).format);
    expect(beginner).not.toContain("B");
    expect(beginner[0]).toBe("A");
  });
});

describe("기록 세트 (T7-3)", () => {
  const session = (set: Record<string, unknown>) => ({
    schema_version: "1.0", session_id: "s", plan_id: "p", date: "2026-08-17", day_index: 0, completion: "completed",
    exercises: [{ exercise_id: "plank", modality: "bodyweight", sets: [{ set_number: 1, set_kind: "working", ...set }] }],
  });
  it("시간 세트 분기 · 기존 렙+무게 · cardio 분기 그대로 · 섞으면 거절", () => {
    expect(checkPerformedSession(session({ actual_seconds: 30 })).ok).toBe(true);
    expect(checkPerformedSession(session({ actual_reps: 10, actual_load_kg: 0 })).ok).toBe(true);
    expect(checkPerformedSession(session({ cardio: { modality: "running", duration_min: 10 } })).ok).toBe(true);
    expect(checkPerformedSession(session({ actual_seconds: 30, cardio: { modality: "running", duration_min: 10 } })).ok).toBe(false);
    expect(checkPerformedSession(session({})).ok).toBe(false);
  });
});

describe("스키마 — 시간 세트는 서킷 A 에만 (codex N7a R1)", () => {
  const plan = expand({ circuits: true }).plan as { week: Array<{ exercises: Array<Record<string, unknown>> }> };
  const mutate = (fn: (e: Record<string, unknown>) => void) => {
    const copy = structuredClone(plan);
    fn(copy.week[0]!.exercises[0]!); // 첫 줄은 근력
    return checkWeeklyPlan(copy).ok;
  };
  it("근력 세트에 렙 없이 target_seconds 만 → 거절 · 근력 세트에 target_seconds 추가 → 거절", () => {
    expect(mutate((e) => { e.sets = [{ set_number: 1, set_kind: "working", target_seconds: 30 }]; })).toBe(false);
    expect(mutate((e) => { (e.sets as Array<Record<string, unknown>>)[0]!.target_seconds = 30; })).toBe(false);
  });
  it("서킷 A 세트에 렙 → 거절", () => {
    const copy = structuredClone(plan);
    const a = copy.week.flatMap((d) => d.exercises).find((e) => (e.circuit as { format?: string } | undefined)?.format === "A")!;
    (a.sets as Array<Record<string, unknown>>)[0]!.target_reps_low = 10;
    expect(checkWeeklyPlan(copy).ok).toBe(false);
  });
  it("다른 날을 편집해도 이 날 서킷은 그대로(템플릿 순번 고정)", () => {
    const before = rows(expand({ circuits: true }).plan).map((d) => d.exercises.find((e) => e.circuit)?.circuit?.id);
    const draft = structuredClone(DRAFT) as { week: Array<Record<string, unknown>> };
    draft.week[0]!.cardio_override = "none";
    const after = rows(expand({ circuits: true, draft }).plan).map((d) => d.exercises.find((e) => e.circuit)?.circuit?.id);
    expect(after.slice(1)).toEqual(before.slice(1));
  });
});

describe("codex N7a R2 — 서킷 빼기 · 하루 비우기 · 부상", () => {
  it("remove_circuit → 그 날 유산소 「뺐다」 · 재확장에서 그 날 서킷 없음, 근력은 그대로 · 서킷 없는 날은 400", () => {
    const first = expand({ circuits: true });
    const edited = applyEdit(first.draft, { op: "remove_circuit", day_index: 2 }, first.plan);
    expect("draft" in edited).toBe(true);
    const again = expand({ circuits: true, draft: (edited as { draft: unknown }).draft });
    const day2 = rows(again.plan).find((d) => d.day_index === 2)!.exercises;
    expect(day2.some((e) => e.circuit)).toBe(false);
    expect(day2.some((e) => e.exercise_id === "bodyweight_squat")).toBe(true);
    expect("error" in applyEdit(expand().draft, { op: "remove_circuit", day_index: 2 }, expand().plan)).toBe(true);
  });

  it("하루를 비워도 다른 날 서킷은 그대로(저장 드래프트에 고정한 템플릿)", () => {
    const first = expand({ circuits: true });
    const before = rows(first.plan).map((d) => [d.day_index, d.exercises.find((e) => e.circuit)?.circuit?.id]);
    const cleared = applyEdit(first.draft, { op: "clear_day", day_index: 0 }, first.plan);
    const after = rows(expand({ circuits: true, draft: (cleared as { draft: unknown }).draft }).plan).map((d) => [d.day_index, d.exercises.find((e) => e.circuit)?.circuit?.id]);
    expect(after.filter(([d]) => d !== 0)).toEqual(before.filter(([d]) => d !== 0));
  });

  it("부상 부위를 쓰는 서킷 동작은 빠진다(S-GEN-4)", () => {
    const out = expand({ circuits: true, profile: profile({ injuries: [{ region: "shoulders" }] }) });
    expect(out.problems).toEqual([]);
    const moves = rows(out.plan).flatMap((d) => d.exercises.filter((e) => e.circuit));
    for (const m of moves) expect(byId(m.exercise_id)!.contraindication_tags).not.toContain("shoulders");
  });
});

describe("codex N7a R4 — 도구 · 요일 이동", () => {
  it("도구 없는 맨몸이면 requires 가 있는 서킷 동작(스텝·의자)이 없다", () => {
    const moves = rows(expand({ circuits: true }).plan).flatMap((d) => d.exercises.filter((e) => e.circuit));
    expect(moves.filter((m) => (byId(m.exercise_id)!.requires ?? []).length > 0).map((m) => m.exercise_id)).toEqual([]);
  });

  it("요일 swap 이면 고정한 서킷 템플릿도 따라간다", () => {
    const first = expand({ circuits: true });
    const at = (plan: unknown, day: number) => rows(plan).find((d) => d.day_index === day)!.exercises.find((e) => e.circuit)?.circuit?.name;
    const before0 = at(first.plan, 0);
    const before2 = at(first.plan, 2);
    expect(before0).not.toBe(before2);
    const moved = applyEdit(first.draft, { op: "move", day_index: 0, to_day_index: 2, mode: "swap" }, first.plan);
    const after = expand({ circuits: true, draft: (moved as { draft: unknown }).draft }).plan;
    expect(at(after, 2)).toBe(before0);
    expect(at(after, 0)).toBe(before2);
  });
});

describe("같은 날 근력 종목과 서킷 동작이 겹치지 않는다(N7b 브라우저 검증에서 발견)", () => {
  it("한 날에 같은 exercise_id 가 두 줄 없다 — 기록이 종목 id 로 묶인다", () => {
    for (const level of ["beginner", "novice_intermediate"] as const) {
      for (const day of rows(expand({ circuits: true, profile: profile({ experience_level: level }) }).plan)) {
        const ids = day.exercises.map((e) => e.exercise_id);
        expect(new Set(ids).size, `${level} d${day.day_index}`).toBe(ids.length);
      }
    }
  });
});

describe("플래그(N7b 에서 켬)", () => {
  it("기본 켬 · CIRCUIT_GENERATION=off 면 끔", async () => {
    const { buildConfig } = await import("../src/config");
    expect(buildConfig({ LLM_API_KEY: "k" }).circuits).toBe(true);
    expect(buildConfig({ LLM_API_KEY: "k", CIRCUIT_GENERATION: "off" }).circuits).toBe(false);
  });
});
