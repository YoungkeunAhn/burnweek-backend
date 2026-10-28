/**
 * 종목 이력 집계 — 백로그 025 §2 · [실행 그래프 N0](../../docs/guides/miniapp-025-execution-graph.md) T0-1~T0-5·T0-7.
 *
 * 규칙표(025 §2)를 **행 단위로** 잡는다. uid 격리(T0-6)와 `weeks` 가 실제로 질의를
 * 자르는지(T0-4 의 절반)는 순수함수 밖의 일이라 계약 테스트
 * (`generation-api-contract.test.ts`)가 본다.
 */
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import {
  EXERCISE_HISTORY_DEFAULT_WEEKS,
  EXERCISE_HISTORY_MAX_WEEKS,
  clampWeeks,
  exerciseHistory,
} from "../src/generation/history";
import type { SavedWeek } from "../src/generation/edit";

const SQUAT = "barbell_squat";

/** 워킹 세트 하나. 화면(`toPerformedSession`)이 싣는 것과 같은 모양이다. */
const set = (n: number, kg: number, reps: number, kind = "working") => ({
  set_number: n,
  set_kind: kind,
  actual_reps: reps,
  actual_load_kg: kg,
});

/** 주차 문서 하나 — 요일 0 에 그 종목 한 개가 실린 세션. */
function week(
  weekStart: string,
  sets: Array<Record<string, unknown>>,
  exerciseId = SQUAT,
): SavedWeek {
  return {
    week_start_date: weekStart,
    sessions: {
      0: {
        schema_version: "1.0",
        session_id: `s-${weekStart}`,
        plan_id: "p",
        date: weekStart,
        day_index: 0,
        completion: "completed",
        exercises: [{ exercise_id: exerciseId, modality: "strength", sets }],
      },
    },
  };
}

describe("exerciseHistory — 백로그 025 §2 규칙표", () => {
  it("T0-1 previous 는 '지난주'가 아니라 '그 종목을 마지막으로 한 주'다 (격주)", () => {
    // W-1(가장 최근 주)에는 스쿼트가 없고 W-2 에만 있다. "지난주"로 구현하면
    // `null` 이 나와 여기서 죽는다 — 격주로 하는 종목의 이력이 영영 안 뜬다.
    const weeks: SavedWeek[] = [
      week("2026-08-24", [set(1, 60, 10)], "barbell_bench_press"),
      week("2026-08-17", [set(1, 50, 12)]),
      week("2026-08-10", [set(1, 45, 12)]),
    ];
    const { previous } = exerciseHistory(weeks, SQUAT, 26);
    expect(previous).toMatchObject({ week_start_date: "2026-08-17", top_load_kg: 50, top_reps: 12 });
  });

  it("T0-1' 입력 순서를 믿지 않는다 — 오래된 주가 먼저 와도 최신을 고른다", () => {
    const weeks = [week("2026-08-10", [set(1, 45, 12)]), week("2026-08-17", [set(1, 50, 12)])];
    expect(exerciseHistory(weeks, SQUAT, 26).previous!.week_start_date).toBe("2026-08-17");
  });

  it("🔴 previous 는 이번 주를 뺀다 — 오늘 저장한 값이 '이전' 이 되면 안 된다 (G4 2026-08-31)", () => {
    // 이번 주(08-31)에 이미 그 종목을 했다. 안 빼면 `이전` 이 방금 한 값이 되어
    // 증감 화살표가 두 번째 방문부터 항상 `=` 다.
    const weeks = [
      week("2026-08-31", [set(1, 60, 12)]),
      week("2026-08-17", [set(1, 50, 12)]),
    ];
    const { previous } = exerciseHistory(weeks, SQUAT, 26, "2026-08-31");
    expect(previous).toMatchObject({ week_start_date: "2026-08-17", top_load_kg: 50 });
    // 이번 주가 유일한 기록이면 `이전` 은 없다 — `0` 도 이번 주 값도 아니다.
    expect(exerciseHistory([weeks[0]!], SQUAT, 26, "2026-08-31").previous).toBeNull();
    // 인자를 안 주면 아무것도 빼지 않는다(옛 호출자·요약 경로).
    expect(exerciseHistory(weeks, SQUAT, 26).previous).toMatchObject({ week_start_date: "2026-08-31" });
  });

  it("🔴 best 는 이번 주를 포함한다 — 오늘 세운 기록도 기록이다", () => {
    const weeks = [
      week("2026-08-31", [set(1, 100, 12)]), // 오늘의 PR
      week("2026-08-17", [set(1, 50, 12)]),
    ];
    const { previous, best } = exerciseHistory(weeks, SQUAT, 26, "2026-08-31");
    expect(best).toMatchObject({ week_start_date: "2026-08-31", top_load_kg: 100, volume_kg: 1200 });
    // 같은 호출에서 previous 는 지난 기록이다 — 두 줄이 다른 주를 가리킨다.
    expect(previous).toMatchObject({ week_start_date: "2026-08-17", top_load_kg: 50 });
  });

  it("T0-2 워킹 세트만 센다 — 웜업은 볼륨에도 최고 무게에도 안 든다", () => {
    // 웜업이 더 무겁게 실린 픽스처. 섞으면 top_load 가 100 이 된다.
    const weeks = [week("2026-08-17", [set(1, 100, 5, "warmup"), set(2, 50, 12)])];
    const { previous, best } = exerciseHistory(weeks, SQUAT, 26);
    expect(previous).toMatchObject({ top_load_kg: 50, top_reps: 12, volume_kg: 600 });
    expect(best!.top_load_kg).toBe(50);
  });

  it("회수 0 인 세트는 빼고 센다 — 들지도 않은 무게가 최고 1RM 이 되면 안 된다", () => {
    // 스키마가 `actual_reps: 0` 을 허용한다(체크한 뒤 회수를 0 으로 적은 경우).
    // Epley 는 거기서 정의되지 않으므로 그 세트는 한 세트가 아니다.
    expect(exerciseHistory([week("2026-08-17", [set(1, 50, 0)])], SQUAT, 26))
      .toEqual({ previous: null, best: null });
    // 같은 주에 진짜 세트가 있으면 그것만 센다.
    const { previous } = exerciseHistory([week("2026-08-17", [set(1, 50, 0), set(2, 40, 10)])], SQUAT, 26);
    expect(previous).toMatchObject({ top_load_kg: 40, top_reps: 10, one_rm_kg: 53.3, volume_kg: 400 });
    // 맨몸 0kg 은 다르다 — 실제로 한 세트라 볼륨 0 으로 든다.
    expect(exerciseHistory([week("2026-08-17", [set(1, 0, 12)])], SQUAT, 26).previous)
      .toMatchObject({ top_load_kg: 0, top_reps: 12, one_rm_kg: 0, volume_kg: 0 });
  });

  it("T0-3 처음 하는 종목은 previous·best 가 null 이다 (0 이 아니다)", () => {
    const weeks = [week("2026-08-17", [set(1, 50, 12)])];
    expect(exerciseHistory(weeks, "deadlift", 26)).toEqual({ previous: null, best: null });
    // 주차 문서가 아예 없을 때도 같다.
    expect(exerciseHistory([], SQUAT, 26)).toEqual({ previous: null, best: null });
    // 그 종목이 실렸지만 워킹 세트가 하나도 없는 주도 "한 주"가 아니다.
    expect(exerciseHistory([week("2026-08-17", [set(1, 40, 8, "warmup")])], SQUAT, 26))
      .toEqual({ previous: null, best: null });
  });

  it("T0-4 weeks 는 기본 26·최대 52 로 자른다", () => {
    expect(EXERCISE_HISTORY_DEFAULT_WEEKS).toBe(26);
    expect(EXERCISE_HISTORY_MAX_WEEKS).toBe(52);
    const clamp = (raw: unknown) =>
      clampWeeks(raw, EXERCISE_HISTORY_DEFAULT_WEEKS, EXERCISE_HISTORY_MAX_WEEKS);
    expect(clamp(999)).toBe(52);
    expect(clamp(undefined)).toBe(26);
    expect(clamp("abc")).toBe(26);
    expect(clamp(0)).toBe(1);
    expect(clamp(-5)).toBe(1);
    expect(clamp("12")).toBe(12);
    expect(clamp(12.9)).toBe(12);
    // 요약 모드는 다른 축이다(계약 §2.6 — 기본 12·상한 26).
    expect(clampWeeks(999, 12, 26)).toBe(26);
  });

  it("T0-4' limit 이 구간 밖의 주를 실제로 잘라낸다", () => {
    const weeks = [week("2026-08-24", [set(1, 60, 10)]), week("2026-08-17", [set(1, 80, 10)])];
    // 최신 1주만 본다 — 더 무거웠던 옛 주는 best 에도 안 든다.
    expect(exerciseHistory(weeks, SQUAT, 1).best!.top_load_kg).toBe(60);
    expect(exerciseHistory(weeks, SQUAT, 2).best!.top_load_kg).toBe(80);
  });

  it("T0-5 best 는 previous 를 포함해 전 구간 최대 — 최근이 최고면 두 줄이 같다", () => {
    const weeks = [week("2026-08-24", [set(1, 80, 10)]), week("2026-08-17", [set(1, 50, 12)])];
    const { previous, best } = exerciseHistory(weeks, SQUAT, 26);
    expect(best).toEqual(previous);
  });

  it("T0-5' best 는 항목별 최대다 — 최고 무게 주와 최고 볼륨 주가 다를 수 있다", () => {
    // 025 §2 의 예시가 그렇다: `최고 82.5 × 15` 의 Epley(123.75)와 `최고 1RM`(122.4)이
    // 다르다 — 세 값이 한 주에서 같이 나온 것이 아니라는 뜻이다.
    const weeks = [
      week("2026-08-24", [set(1, 40, 20), set(2, 40, 20), set(3, 40, 20)]), // 볼륨 2400
      week("2026-08-17", [set(1, 80, 5)]), // 최고 무게 80, 볼륨 400
    ];
    const { best } = exerciseHistory(weeks, SQUAT, 26);
    expect(best).toMatchObject({
      week_start_date: "2026-08-17", // 최고 무게가 나온 주
      top_load_kg: 80,
      top_reps: 5, // **쌍으로 움직인다** — 20 이 오면 하지도 않은 `80 × 20` 이 된다
      volume_kg: 2400, // 다른 주에서 온 최대
    });
    // 1RM 도 항목별 최대다: 40×20 → 66.7, 80×5 → 93.3.
    expect(best!.one_rm_kg).toBe(93.3);
    // 계약 §2.6.1 이 적어 둔 불변식 — `one_rm_kg` 는 구간 최대라 `top_load × top_reps`
    // 의 Epley(소수 1자리) 이상이다. 예시 숫자가 이걸 어기면 계약이 거짓말을 한다.
    const epley1 = Math.round(best!.top_load_kg * (1 + best!.top_reps / 30) * 10) / 10;
    expect(best!.one_rm_kg).toBeGreaterThanOrEqual(epley1);
  });

  it("1RM 은 Epley 다 — loading.ts 와 같은 식", () => {
    const { previous } = exerciseHistory([week("2026-08-17", [set(1, 50, 12)])], SQUAT, 26);
    // 50 × (1 + 12/30) = 70
    expect(previous!.one_rm_kg).toBe(70);
    expect(previous!.volume_kg).toBe(600);
  });

  it("같은 무게면 회수가 많은 세트가 위다", () => {
    const { previous } = exerciseHistory([week("2026-08-17", [set(1, 50, 11), set(2, 50, 12)])], SQUAT, 26);
    expect(previous).toMatchObject({ top_load_kg: 50, top_reps: 12 });
  });

  it("한 주에 그 종목이 두 요일에 있으면 합쳐서 한 주로 센다", () => {
    const w = week("2026-08-17", [set(1, 50, 10)]);
    (w.sessions as Record<string, unknown>)["3"] = {
      exercises: [{ exercise_id: SQUAT, modality: "strength", sets: [set(1, 60, 10)] }],
    };
    const { previous } = exerciseHistory([w], SQUAT, 26);
    expect(previous).toMatchObject({ top_load_kg: 60, volume_kg: 1100 });
  });

  it("모양이 깨진 옛 문서에서 터지지 않는다", () => {
    const junk = [
      { week_start_date: "2026-08-24", sessions: { 0: { exercises: "nope" } } },
      { week_start_date: "2026-08-23", sessions: "nope" },
      { week_start_date: "2026-08-22" },
      { week_start_date: "2026-08-21", sessions: { 0: null } },
      // 유산소 세트에는 `actual_load_kg`·`actual_reps` 가 없다 — 걸러진다.
      { week_start_date: "2026-08-20", sessions: { 0: { exercises: [{ exercise_id: SQUAT, sets: [{ set_number: 1, set_kind: "working", cardio: { modality: "rowing", duration_min: 20 } }] }] } } },
      week("2026-08-17", [set(1, 50, 12)]),
    ] as unknown as SavedWeek[];
    expect(exerciseHistory(junk, SQUAT, 26).previous!.week_start_date).toBe("2026-08-17");
  });

  it("exercise_id 가 비면 아무것도 주지 않는다", () => {
    expect(exerciseHistory([week("2026-08-17", [set(1, 50, 12)])], "", 26))
      .toEqual({ previous: null, best: null });
  });

  it("T0-7 응답이 계약 §2.6 의 새 절과 같은 모양이다", () => {
    const schema = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: false,
      required: ["status", "previous", "best"],
      properties: {
        status: { const: "ok" },
        previous: { $ref: "#/$defs/stat" },
        best: { $ref: "#/$defs/stat" },
      },
      $defs: {
        stat: {
          oneOf: [
            { type: "null" },
            {
              type: "object",
              additionalProperties: false,
              required: ["week_start_date", "top_load_kg", "top_reps", "one_rm_kg", "volume_kg"],
              properties: {
                week_start_date: { type: "string", pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$" },
                top_load_kg: { type: "number", minimum: 0, maximum: 500 },
                top_reps: { type: "integer", minimum: 0 },
                one_rm_kg: { type: "number", minimum: 0 },
                volume_kg: { type: "number", minimum: 0 },
              },
            },
          ],
        },
      },
    };
    const validate = new Ajv2020({ allErrors: true, strict: false }).compile(schema);

    const withData = { status: "ok", ...exerciseHistory([week("2026-08-17", [set(1, 50, 12)])], SQUAT, 26) };
    expect(validate(withData), JSON.stringify(validate.errors)).toBe(true);
    const empty = { status: "ok", ...exerciseHistory([], SQUAT, 26) };
    expect(validate(empty), JSON.stringify(validate.errors)).toBe(true);
  });
});
