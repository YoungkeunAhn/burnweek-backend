import { describe, expect, it } from "vitest";
import { buildConfig, pipelineFor } from "../src/config";
import type { DraftRequest, LLMProvider } from "../src/llm";
import { applyEdit } from "../src/generation/edit";
import { generatePlan } from "../src/generation/handler";
import { stripNumbers } from "../src/generation/prompt";
import { buildSkeleton, resolveSlotDraft, type SkeletonDay } from "../src/generation/slots";
import { checkSlotDraft } from "../src/schemas/validate";
import { evaluatePlan } from "./eval/evaluate";
import { EVAL_PROFILES } from "./fixtures/golden-profiles";

// P1 생성 경로(실행 그래프 N8b · ADR-0025) — 실제 LLM 없이 슬롯 후보를 읽는 가짜 provider 로 돈다.

/** 사용자 턴의 골격 표에서 슬롯 → 후보를 읽는다(`buildSlotUserContext` 형식). */
function slotsOf(userContext: string): Array<{ slot: string; candidates: string[] }> {
  const out: Array<{ slot: string; candidates: string[] }> = [];
  for (const line of userContext.split("\n")) {
    const slot = /^ {2}(d\d+s\d+) · /.exec(line);
    if (slot) out.push({ slot: slot[1]!, candidates: [] });
    const cand = /^ {4}([a-z0-9_]+) \| /.exec(line);
    if (cand && out.length > 0) out[out.length - 1]!.candidates.push(cand[1]!);
  }
  return out;
}

/** 슬롯마다 n번째 후보를 고르는 가짜 모델. 요청을 기록한다. */
function slotProvider(pick = (_slot: string, candidates: string[]) => candidates[0]!, log: DraftRequest[] = []): LLMProvider {
  return {
    name: "fake-slot",
    capabilities: { streaming: false, jsonSchema: true },
    async generateDraft(req) {
      log.push(req);
      const slots = slotsOf(req.userContext).map(({ slot, candidates }) => ({
        slot,
        exercise_id: pick(slot, candidates),
        reason: "무릎이 편한 기본 운동이라 3세트 10회로 시작해요",
      }));
      return { draft: { slots, week_note: "이번 주는 전신을 2번 돌아요" }, model: "fake" };
    },
  };
}

const P1 = buildConfig({ LLM_API_KEY: "offline", LLM_BASE_URL: "http://offline.invalid", GENERATION_PIPELINE: "p1" });
const P0 = buildConfig({ LLM_API_KEY: "offline", LLM_BASE_URL: "http://offline.invalid", GENERATION_PIPELINE: "p0" });
const AUTO = buildConfig({ LLM_API_KEY: "offline", LLM_BASE_URL: "http://offline.invalid" });
const NOW = Date.parse("2026-08-17T00:00:00+09:00");

function request(id: string) {
  const item = EVAL_PROFILES.find((p) => p.id === id)!;
  return { user_id: "u1", week_start_date: "2026-08-17", profile: item.profile, prior_logs: item.priorLogs ?? [] };
}

describe("슬롯 드래프트 해석 (T8-3)", () => {
  const skeleton: SkeletonDay[] = [
    {
      label: "전신 A",
      slots: [
        { key: "d0s0", pattern: "squat", role: "primary", repIntent: "hypertrophy", candidates: ["leg_press", "hack_squat"] },
        { key: "d0s1", pattern: "h_push", role: "secondary", repIntent: "hypertrophy", candidates: ["leverage_chest_press", "dumbbell_bench_press"] },
        { key: "d0s2", pattern: "h_push", role: "secondary", repIntent: "hypertrophy", candidates: ["leverage_chest_press", "dumbbell_bench_press"] },
      ],
    },
  ];

  it("슬롯 후보 밖 · 다른 슬롯 id · 같은 날 중복 · 빠진 슬롯은 그 슬롯의 다음 후보로", () => {
    const { draft, fallbacks } = resolveSlotDraft(
      {
        slots: [
          { slot: "d0s0", exercise_id: "leverage_chest_press", reason: "x" }, // 다른 슬롯 후보
          { slot: "d0s1", exercise_id: "leverage_chest_press", reason: "가슴 머신이 편해요" },
          { slot: "d0s2", exercise_id: "leverage_chest_press", reason: "y" }, // 같은 날 중복
        ],
      },
      skeleton,
      "full_body",
      stripNumbers,
    );
    const items = (draft.week as Array<{ items: Array<{ exercise_id: string; role: string; order: number; reason?: string }> }>)[0]!.items;
    expect(items.map((i) => i.exercise_id)).toEqual(["leg_press", "leverage_chest_press", "dumbbell_bench_press"]);
    expect(items.map((i) => i.role)).toEqual(["primary", "secondary", "secondary"]);
    expect(items[1]!.reason).toBe("가슴 머신이 편해요");
    // 바꿔 넣은 슬롯에는 LLM 의 이유를 붙이지 않는다(다른 운동의 이유다).
    expect(items[0]!.reason).toBeUndefined();
    expect(fallbacks).toBe(2);
    expect(resolveSlotDraft({ slots: [] }, skeleton, "full_body", stripNumbers).fallbacks).toBe(3);
  });

  it("대체 운동은 같은 슬롯 후보만, 최대 2개", () => {
    const { draft } = resolveSlotDraft(
      { slots: [{ slot: "d0s0", exercise_id: "leg_press", reason: "r", alternatives: ["hack_squat", "barbell_squat", "leg_press"] }] },
      skeleton,
      "full_body",
      stripNumbers,
    );
    const first = (draft.week as Array<{ items: Array<{ alternatives?: string[] }> }>)[0]!.items[0]!;
    expect(first.alternatives).toEqual(["hack_squat"]);
  });
});

describe("편집 교체는 옛 종목의 이유·대체를 지운다", () => {
  it("replace 뒤 reason·alternatives 없음", () => {
    const draft = {
      schema_version: "1.0",
      split_type: "full_body",
      week: [{ day_index: 0, session_type: "lift", focus: "", items: [{ kind: "strength", exercise_id: "leg_press", role: "primary", order: 1, rep_intent: "hypertrophy", reason: "무릎이 편해요", alternatives: ["hack_squat"] }] }],
    };
    const out = applyEdit(draft, { op: "replace", day_index: 0, exercise_id: "leg_press", to_exercise_id: "hack_squat" });
    const item = ((out as { draft: { week: Array<{ items: Array<Record<string, unknown>> }> } }).draft.week[0]!.items[0])!;
    expect(item.exercise_id).toBe("hack_squat");
    expect(item.reason).toBeUndefined();
    expect(item.alternatives).toBeUndefined();
  });
});

describe("이유의 숫자 제거 (T8-4 · INV-1)", () => {
  it("숫자+단위를 지운다", () => {
    expect(stripNumbers("3세트 10회로 가볍게 시작해요")).not.toMatch(/[0-9]/);
    expect(stripNumbers("20kg 으로 30초 쉬어요")).not.toMatch(/[0-9]/);
    expect(stripNumbers("무릎이 편해요")).toBe("무릎이 편해요");
    // 전각 숫자 · 한글 수사 + 단위(codex N8b R1).
    expect(stripNumbers("３세트 １０회")).not.toMatch(/[0-9０-９]/);
    expect(stripNumbers("세 세트 열 번 하면 돼요")).not.toMatch(/세 세트|열 번/);
    expect(stripNumbers("삼 세트씩 십 회 반복하고 이십 킬로그램으로 시작해요")).not.toMatch(/삼 세트|십 회|이십 킬로/);
    expect(stripNumbers("주 삼일 운동하고 이 주 동안 유지해요")).not.toMatch(/삼일|이 주/);
    expect(stripNumbers("다리 힘을 기르는 기본 운동이에요")).toBe("다리 힘을 기르는 기본 운동이에요");
  });
});

describe("P1 생성 경로", () => {
  it("기본은 auto — 헬스장만 p1, 그 밖은 p0 (T10a-1 · D105 ①)", async () => {
    expect(AUTO.pipeline).toBe("auto");
    expect(pipelineFor("auto", "full_gym")).toBe("p1");
    for (const env of ["home_gym", "minimal", "bodyweight_only"]) expect(pipelineFor("auto", env)).toBe("p0");
    expect(pipelineFor("p0", "full_gym")).toBe("p0");
    expect(pipelineFor("p1", "bodyweight_only")).toBe("p1");
    expect(() => buildConfig({ LLM_API_KEY: "k", GENERATION_PIPELINE: "p2" })).toThrow();
    // 배선 — 핸들러가 환경을 실제로 본다(설정값만 보면 헬스장이 p0 으로 남는다).
    const gym: DraftRequest[] = [];
    await generatePlan(request("beginner-2day-fullgym"), { config: AUTO, provider: slotProvider(undefined, gym), now: NOW });
    expect(gym[0]!.systemPrefix).toContain("<slot_draft_schema>");
    const bw: DraftRequest[] = [];
    await generatePlan(request("beginner-bodyweight-only"), { config: AUTO, provider: slotProvider(undefined, bw), now: NOW });
    expect(bw[0]!.systemPrefix).toContain("<draft_plan_schema>");
  });

  it("서킷은 서킷 화면이 있다고 밝힌 클라이언트만 받는다 (T10d-1 · N7a↔N7b 짝)", async () => {
    const hasCircuit = (plan: unknown) =>
      (plan as { week: Array<{ exercises: Array<{ circuit?: unknown }> }> }).week.some((d) => d.exercises.some((e) => e.circuit !== undefined));
    const lose = request("beginner-bodyweight-lose-fat");
    const old = await generatePlan(lose, { config: P1, provider: slotProvider(), now: NOW });
    expect(old.status).toBe("ok");
    expect(hasCircuit(old.plan), "옛 번들(표시 없음)이 서킷을 받았다").toBe(false);
    const fresh = await generatePlan({ ...lose, supports_circuits: true }, { config: P1, provider: slotProvider(), now: NOW });
    expect(fresh.status).toBe("ok");
    expect(hasCircuit(fresh.plan), "새 번들이 서킷을 못 받았다").toBe(true);
    const off = buildConfig({ LLM_API_KEY: "offline", LLM_BASE_URL: "http://offline.invalid", GENERATION_PIPELINE: "p1", CIRCUIT_GENERATION: "off" });
    expect(hasCircuit((await generatePlan({ ...lose, supports_circuits: true }, { config: off, provider: slotProvider(), now: NOW })).plan)).toBe(false);
  });

  it("p0 강제는 운영 프롬프트 그대로 (T8-6)", async () => {
    const log: DraftRequest[] = [];
    await generatePlan(request("beginner-2day-fullgym"), { config: P0, provider: slotProvider(undefined, log), now: NOW });
    expect(log[0]!.systemPrefix).toContain("<draft_plan_schema>");
    expect(log[0]!.systemPrefix).not.toContain("<slot_draft_schema>");
  });

  it("p1 은 슬롯 스키마·골격 표를 보내고, 플랜은 골격대로 · 이유는 숫자 없이 저장", async () => {
    const log: DraftRequest[] = [];
    const res = await generatePlan(request("beginner-2day-fullgym"), { config: P1, provider: slotProvider(undefined, log), now: NOW });
    expect(res.status).toBe("ok");
    expect(log).toHaveLength(1);
    expect(log[0]!.systemPrefix).toContain("<slot_draft_schema>");
    expect(log[0]!.userContext).toContain("<week_skeleton");
    expect(checkSlotDraft({ slots: [{ slot: "d0s0", exercise_id: "leg_press", reason: "r" }] }).ok).toBe(true);
    const skeleton = buildSkeleton(request("beginner-2day-fullgym").profile);
    const lifts = (res.plan as { week: Array<{ exercises: Array<{ exercise_id: string; modality: string }> }> }).week
      .map((d) => d.exercises.filter((e) => e.modality !== "cardio").map((e) => e.exercise_id))
      .filter((ids) => ids.length > 0);
    expect(lifts).toEqual(skeleton.map((d) => d.slots.map((s) => s.candidates[0])));
    const reasons = (res.draft as { week: Array<{ items: Array<{ reason?: string }> }> }).week.flatMap((d) => d.items.map((i) => i.reason ?? ""));
    expect(reasons.every((r) => r.length > 0 && !/[0-9]/.test(r))).toBe(true);
    expect((res.draft as { week_note?: string }).week_note).not.toMatch(/[0-9]/);
  });

  it("평가 프로필 16개 전부 p1 로 생성되고 도구·금기 위반 0, 밀기:당기기 0.75–1.34(맨몸 제외)", async () => {
    for (const item of EVAL_PROFILES) {
      const res = await generatePlan(
        { ...request(item.id), week_number: item.weekNumber ?? 1 },
        { config: P1, provider: slotProvider((slot, c) => c[Number(slot.slice(-1)) % c.length]!), now: NOW },
      );
      expect(res.status, `${item.id}: ${res.message ?? ""}`).toBe("ok");
      // 그 날 메인(첫 근력 종목)은 3세트 이상 — MEV 를 여러 날이 나눠도(expand allocateVolume).
      for (const day of (res.plan as { week: Array<{ exercises: Array<{ modality: string; sets?: Array<{ set_kind: string }> }> }> }).week) {
        const main = day.exercises.find((e) => e.modality !== "cardio");
        if (main) expect((main.sets ?? []).filter((s) => s.set_kind === "working").length, item.id).toBeGreaterThanOrEqual(3);
      }
      const m = evaluatePlan(res.plan, item.profile);
      expect(m.toolViolations, item.id).toEqual([]);
      expect(m.contraindicationViolations, item.id).toEqual([]);
      if (item.profile.environment === "full_gym" && m.pushPullRatio !== null) {
        expect(m.pushPullRatio, item.id).toBeGreaterThanOrEqual(0.75);
        expect(m.pushPullRatio, item.id).toBeLessThanOrEqual(1.34);
      }
    }
  });
});

describe("맨몸 사다리와 P1 슬롯", () => {
  it("로우를 다 채워도 수평 당기기는 풀업으로 바뀌지 않는다 · 사다리가 바꾼 종목은 옛 이유가 없다", async () => {
    const item = EVAL_PROFILES.find((p) => p.id === "beginner-bodyweight-pullup-bar")!;
    const top = (exercise_id: string) => ({
      exercise_id,
      modality: "bodyweight",
      sets: [1, 2, 3].map((set_number) => ({ set_number, set_kind: "working", actual_reps: 30, actual_load_kg: 0, completed: true })),
    });
    const priorLogs = [
      {
        schema_version: "1.0", session_id: "s1", plan_id: "p1", date: "2026-08-10", day_index: 0,
        exercises: [top("towel_door_row"), top("knee_push_up")],
      },
    ];
    const res = await generatePlan(
      { user_id: "u1", week_start_date: "2026-08-17", week_number: 2, profile: item.profile, prior_logs: priorLogs },
      {
        config: P1,
        // LLM 이 지난주 운동(무릎 푸시업·도어 로우)을 그대로 고른다 → 사다리가 다음 칸으로 올린다.
        provider: slotProvider((_slot, c) => c.find((id) => id === "knee_push_up" || id === "towel_door_row") ?? c[0]!),
        now: NOW,
      },
    );
    expect(res.status, res.message).toBe("ok");
    const items = (res.draft as { week: Array<{ items: Array<{ exercise_id: string; reason?: string }> }> }).week.flatMap((d) => d.items);
    // 도어 로우 → 테이블 로우(같은 사다리), 풀업으로는 넘어가지 않는다.
    expect(items.some((i) => i.exercise_id === "table_inverted_row")).toBe(true);
    expect(items.some((i) => i.exercise_id === "towel_door_row")).toBe(false);
    const pushups = items.filter((i) => i.exercise_id === "pushups");
    expect(pushups.length).toBeGreaterThan(0);
    expect(pushups.every((i) => i.reason === undefined)).toBe(true);
    expect(items.filter((i) => i.exercise_id === "table_inverted_row").every((i) => i.reason === undefined)).toBe(true);
  });
});

describe("당기기 사다리는 로우 안에서만", () => {
  it("테이블 로우 상단 달성 → 풀업으로 넘어가지 않고 유지(로우·풀업은 다른 패턴)", async () => {
    const item = EVAL_PROFILES.find((p) => p.id === "beginner-bodyweight-pullup-bar")!;
    const priorLogs = [
      {
        schema_version: "1.0", session_id: "s1", plan_id: "p1", date: "2026-08-10", day_index: 0,
        exercises: [{ exercise_id: "table_inverted_row", modality: "bodyweight", sets: [1, 2, 3].map((set_number) => ({ set_number, set_kind: "working", actual_reps: 30, actual_load_kg: 0, completed: true })) }],
      },
    ];
    const res = await generatePlan(
      { user_id: "u1", week_start_date: "2026-08-17", week_number: 2, profile: item.profile, prior_logs: priorLogs },
      { config: P1, provider: slotProvider((_slot, c) => c.find((id) => id === "table_inverted_row") ?? c[0]!), now: NOW },
    );
    expect(res.status, res.message).toBe("ok");
    const items = (res.draft as { week: Array<{ items: Array<{ exercise_id: string }> }> }).week.flatMap((d) => d.items.map((i) => i.exercise_id));
    expect(items).toContain("table_inverted_row");
  });
});

describe("평가 지표 — 어깨 분류(codex N9 R1)", () => {
  it("패턴을 모르는 후면 어깨(reverse_machine_flyes)는 당기기 · 측면 레이즈는 어느 쪽도 아님", () => {
    const plan = (id: string) => ({ week: [{ day_index: 0, exercises: [{ exercise_id: id, modality: "strength", sets: [{ set_number: 1, set_kind: "working" }] }] }] });
    const p = request("beginner-2day-fullgym").profile;
    expect(evaluatePlan(plan("reverse_machine_flyes"), p).pullSets).toBe(1);
    const side = evaluatePlan(plan("bent_over_low_pulley_side_lateral"), p);
    expect([side.pushSets, side.pullSets]).toEqual([0, 0]);
  });
});

// 2026-10-19 보고 — 완료한 날 당일 재생성이 「day 2 는 가슴·삼두 날인데 …(lats)」로 전부 실패했다.
// 골격이 완료일을 한 칸으로 세어 분할 검사(`slotAssignment`)와 한 칸 어긋났다.
describe("완료한 날 당일 재생성 — 골격과 분할 검사가 같은 요일→부위", () => {
  const split3 = { ...EVAL_PROFILES.find((p) => p.id === "beginner-3day-cardio-none")!.profile, split_pref: "body_part_3" as const };
  const regen = (done: string[], now: string) =>
    generatePlan(
      { user_id: "u1", week_start_date: "2026-10-19", profile: split3, prior_logs: [], completed_this_week: [{ day_index: 0, exercise_ids: done }] },
      { config: P1, provider: slotProvider(), now: Date.parse(now) },
    );

  it.each([
    ["하체", ["leg_press"], ["하체·어깨", "가슴·삼두", "등·이두"]],
    ["가슴", ["dumbbell_bench_press"], ["가슴·삼두", "등·이두", "하체·어깨"]],
  ])("월 생성 · 월 완료(%s) → ok · 수·금은 완료 부위 다음부터", async (_name, done, labels) => {
    const res = await regen(done, "2026-10-19T20:00:00+09:00");
    expect(res.status, res.message).toBe("ok");
    expect(buildSkeleton(split3, { completed: [{ day_index: 0, exercise_ids: done }] }).map((d) => d.label)).toEqual(labels);
  });

  it("화 생성 · 월 완료 → ok(지난 날 완료는 종전과 같다)", async () => {
    const res = await regen(["dumbbell_bench_press"], "2026-10-20T08:00:00+09:00");
    expect(res.status, res.message).toBe("ok");
  });

  it("분할 미선택 · 월 완료 → 골격 순서는 종전(D60 Q5 — codex N1 R1)", () => {
    const { split_pref: _none, ...plain } = split3;
    expect(buildSkeleton(plain, { completed: [{ day_index: 0, exercise_ids: ["leg_press"] }] }).map((d) => d.label)).toEqual(["전신 A", "전신 B", "전신 A"]);
  });

  it("분할 미선택 · 완료 없음 → 골격 순서는 종전(템플릿 차례)", () => {
    const { split_pref: _none, ...plain } = split3;
    expect(buildSkeleton({ ...plain, days_per_week: 5 }).map((d) => d.label)).toEqual(["상체", "하체", "밀기", "당기기", "하체"]);
  });
});
