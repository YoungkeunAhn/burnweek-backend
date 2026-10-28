/** 유산소 설정 방식 표와 범위 — D57 A2·A4·A12 · 041 N1(T1-1~T1-5). */
import { describe, expect, it } from "vitest";
import catalogue from "../src/data/exercises.json";
import { CARDIO_EXERCISES, CARDIO_EXERCISE_IDS, cardioRangeProblems, type CardioModality } from "../src/generation/cardio";
import { saveSessionOn } from "../src/generation/session";

describe("설정 방식 표 (T1-1)", () => {
  // D57 A4 설정 방식 · 041 G0 Q5 내부 분류를 표 밖에서 다시 적는다 — 표가 틀리면 여기와 갈린다.
  const EXPECTED: Record<string, [CardioModality, string]> = {
    running_treadmill: ["running", "run"],
    jogging_treadmill: ["running", "run"],
    trail_running_walking: ["running", "run"],
    walking_treadmill: ["incline_walk", "walk"],
    mymountain: ["incline_walk", "walk"],
    bicycling_stationary: ["cycling", "level"],
    recumbent_bike: ["cycling", "level"],
    elliptical_trainer: ["elliptical", "level"],
    stairmaster: ["stairs", "level"],
    step_mill: ["stairs", "level"],
    bicycling: ["cycling", "distance"],
    rowing_stationary: ["rowing", "distance"],
    rope_jumping: ["running", "time"],
  };

  it("13종 · 설정 방식·내부 분류가 D57 과 같다", () => {
    expect(Object.fromEntries(Object.entries(CARDIO_EXERCISES).map(([id, s]) => [id, [s.modality, s.form]]))).toEqual(EXPECTED);
  });

  it("13종 전부 카탈로그의 유산소다", () => {
    const cardio = new Set((catalogue as { id: string; category: string }[]).filter((e) => e.category === "cardio").map((e) => e.id));
    for (const id of Object.keys(CARDIO_EXERCISES)) expect(cardio.has(id), id).toBe(true);
  });

  it("기존 6종의 분류는 CARDIO_EXERCISE_IDS 와 같다", () => {
    for (const [modality, id] of Object.entries(CARDIO_EXERCISE_IDS)) expect(CARDIO_EXERCISES[id]!.modality).toBe(modality);
  });
});

describe("범위 경계 (T1-2)", () => {
  const ok = (id: string, cardio: object) => expect(cardioRangeProblems(id, cardio), JSON.stringify(cardio)).toEqual([]);
  const bad = (id: string, cardio: object) => expect(cardioRangeProblems(id, cardio), JSON.stringify(cardio)).not.toEqual([]);

  it("트레드밀 경사 -3–20 · 마이마운틴 -5–50", () => {
    ok("running_treadmill", { duration_min: 30, incline_pct: -3 });
    ok("running_treadmill", { duration_min: 30, incline_pct: 20 });
    bad("running_treadmill", { duration_min: 30, incline_pct: -3.1 });
    bad("running_treadmill", { duration_min: 30, incline_pct: 20.1 });
    ok("mymountain", { duration_min: 30, incline_pct: 50 });
    bad("mymountain", { duration_min: 30, incline_pct: 50.1 });
    ok("mymountain", { duration_min: 30, incline_pct: 30 });
  });

  it("속도 — 트레드밀 30 · 마이마운틴 10 (구간)", () => {
    ok("walking_treadmill", { duration_min: 20, segments: [{ sec: 60, speed_kmh: 30 }] });
    bad("walking_treadmill", { duration_min: 20, segments: [{ sec: 60, speed_kmh: 30.1 }] });
    bad("mymountain", { duration_min: 20, segments: [{ sec: 60, speed_kmh: 10.1 }] });
  });

  it("레벨 1–30 · 구간 1–3600초 · 총 시간 1–300 · 거리 100–100000m", () => {
    ok("bicycling_stationary", { duration_min: 30, level: 1 });
    bad("bicycling_stationary", { duration_min: 30, level: 0 });
    bad("bicycling_stationary", { duration_min: 30, level: 31 });
    bad("bicycling_stationary", { duration_min: 30, level: 5.5 }); // 레벨은 정수(A5)
    bad("bicycling_stationary", { duration_min: 30.5 }); // 총 시간은 정수(스키마)
    // 하한은 오타 방지뿐이다(D57 A12, 2026-09-16 조정) — 1초는 받고 0·음수만 막는다.
    ok("rope_jumping", { duration_min: 10, segments: [{ sec: 1 }, { sec: 3600 }] });
    bad("rope_jumping", { duration_min: 10, segments: [{ sec: 0 }] });
    bad("rope_jumping", { duration_min: 10, segments: [{ sec: -1 }] });
    bad("rope_jumping", { duration_min: 10, segments: [{ sec: 3601 }] });
    bad("rope_jumping", { duration_min: 10, segments: [{ sec: 60.5 }] }); // 구간 시간은 정수(스키마)
    bad("rope_jumping", { duration_min: 301 });
    ok("rowing_stationary", { duration_min: 20, distance_m: 100 });
    bad("rowing_stationary", { duration_min: 20, distance_m: 99 });
    bad("bicycling", { duration_min: 20, distance_m: 100_001 });
  });

  it("표에 없는 id(옛 기록)는 옛 칸(시간·거리)만 받는다", () => {
    ok("stationary_bike", { duration_min: 20, distance_m: 5000 });
    bad("stationary_bike", { duration_min: 0 });
    bad("stationary_bike", { duration_min: 20, incline_pct: 5 });
    bad("stationary_bike", { duration_min: 20, level: 5 });
    bad("stationary_bike", { duration_min: 20, segments: [{ sec: 60 }] });
  });
});

describe("세션 PUT 판정 (T1-3 · T1-4 · T1-5)", () => {
  const body = (exerciseId: string, cardio: object) => ({
    schema_version: "1.0",
    session_id: "s",
    plan_id: "p",
    date: "2026-08-17",
    day_index: 0,
    completion: "completed",
    completion_pct: 1,
    exercises: [{ exercise_id: exerciseId, modality: "cardio", sets: [{ set_number: 1, set_kind: "working", cardio: { modality: "cycling", ...cardio } }] }],
  });
  const put = (exerciseId: string, cardio: object) => saveSessionOn(true, "0", body(exerciseId, cardio));

  it("T1-3 설정 방식에 없는 칸은 400 — 사이클에 경사 · 실외 러닝·걷기에 경사 · 사이클에 거리", () => {
    expect(put("bicycling_stationary", { duration_min: 30, incline_pct: 5 }).code).toBe(400);
    expect(put("trail_running_walking", { duration_min: 30, incline_pct: 5 }).code).toBe(400);
    expect(put("bicycling_stationary", { duration_min: 30, distance_m: 5000 }).code).toBe(400);
    const out = put("bicycling_stationary", { duration_min: 30, segments: [{ sec: 60, speed_kmh: 20 }] });
    expect(out.code).toBe(400);
    expect(out.body.message).toMatch(/칸이 없는/);
  });

  it("T1-4 구간 100개 통과 · 101개 400", () => {
    const segs = (n: number) => Array.from({ length: n }, () => ({ sec: 60, level: 5 }));
    expect(put("elliptical_trainer", { duration_min: 100, style: "HIIT", segments: segs(100) }).code).toBe(200);
    expect(put("elliptical_trainer", { duration_min: 100, style: "HIIT", segments: segs(101) }).code).toBe(400);
  });

  it("T1-5 옛 기록(duration_min 만)은 200 이고 그대로 저장된다", () => {
    const old = body("bicycling_stationary", { style: "LISS", duration_min: 20 });
    const out = saveSessionOn(true, "0", old);
    expect(out.code).toBe(200);
    expect(out.save?.session).toEqual(old);
    expect(put("stationary_bike", { duration_min: 20 }).code).toBe(200);
  });

  // 067 · D77 — 기록 총 시간은 분·초. 초 0–59 정수 · 분 하한 0 · 분+초 > 0. 계획 목표(`cardio` op)는 그대로 1분 하한이고 초 칸이 없다.
  it("T7-1 옛 페이로드(초 없음)는 그대로 200 이고 duration_sec 이 생기지 않는다", () => {
    const old = body("running_treadmill", { style: "LISS", duration_min: 20 });
    const out = saveSessionOn(true, "0", old);
    expect(out.code).toBe(200);
    expect("duration_sec" in (out.save!.session as { exercises: { sets: { cardio: object }[] }[] }).exercises[0]!.sets[0]!.cardio).toBe(false);
  });

  it("T7-2 분 20 · 초 45 는 200 이고 그대로 저장된다", () => {
    const withSec = body("running_treadmill", { style: "LISS", duration_min: 20, duration_sec: 45 });
    const out = saveSessionOn(true, "0", withSec);
    expect(out.code).toBe(200);
    expect(out.save?.session).toEqual(withSec);
  });

  it("T7-3 초 60 · -1 · 4.5 는 400 — 스키마가 먼저 막고(모양), 범위 함수도 같은 답이다", () => {
    for (const duration_sec of [60, -1, 4.5]) {
      expect(put("running_treadmill", { duration_min: 20, duration_sec }).code, String(duration_sec)).toBe(400);
      expect(cardioRangeProblems("running_treadmill", { duration_min: 20, duration_sec }, { record: true })[0]).toMatch(/총 시간\(초\)/);
    }
  });

  it("T7-4 분 0 · 초 30 은 200 (1분 미만 기록)", () => {
    expect(put("running_treadmill", { duration_min: 0, duration_sec: 30 }).code).toBe(200);
  });

  it("T7-7 0분 0초 · 0분(초 없음)은 400", () => {
    const out = put("running_treadmill", { duration_min: 0, duration_sec: 0 });
    expect(out.code).toBe(400);
    expect(out.body.message).toMatch(/0분 0초/);
    expect(put("running_treadmill", { duration_min: 0 }).code).toBe(400);
  });

  it("T7-8b 계획 cardio op 에 duration_sec 을 보내면 400 — 조용히 버리지 않는다(D77 · 계약 §2.4)", async () => {
    const { parseEdit } = await import("../src/generation/edit");
    const out = parseEdit({ op: "cardio", day_index: 0, exercise_id: "running_treadmill", cardio: { style: "LISS", duration_min: 20, duration_sec: 30 } });
    expect("error" in out && out.error).toMatch(/초/);
    expect("error" in parseEdit({ op: "cardio", day_index: 0, exercise_id: "running_treadmill", cardio: { style: "LISS", duration_min: 20 } })).toBe(false);
  });

  it("T7-8 계획 목표는 그대로 1분 하한 · 초 칸 없음(cardioRangeProblems 기본 모드)", () => {
    expect(cardioRangeProblems("running_treadmill", { duration_min: 0 })).not.toEqual([]);
    expect(cardioRangeProblems("running_treadmill", { duration_min: 1 })).toEqual([]);
    expect(cardioRangeProblems("running_treadmill", { duration_min: 20, duration_sec: 30 })).not.toEqual([]);
    expect(cardioRangeProblems("running_treadmill", { duration_min: 0, duration_sec: 30 }, { record: true })).toEqual([]);
  });

  it("새 칸이 다 있는 러닝 인터벌 기록은 200", () => {
    const out = put("running_treadmill", {
      style: "HIIT",
      duration_min: 20,
      distance_m: 3200,
      incline_pct: 1,
      segments: [
        { label: "워밍업", sec: 300, speed_kmh: 6 },
        { label: "질주", sec: 60, speed_kmh: 12, incline_pct: 2 },
        { label: "회복", sec: 60, speed_kmh: 5.5 },
      ],
    });
    expect(out.code, JSON.stringify(out.body)).toBe(200);
  });
});
