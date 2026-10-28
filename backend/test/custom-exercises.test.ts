/** 커스텀 카탈로그 원천 — D57 A15 · 041 N2(T2-1 · T2-2). */
import { describe, expect, it } from "vitest";
import catalogue from "../src/data/exercises.json";
import custom from "../scripts/custom-exercises.json";
import overrides from "../scripts/catalog-overrides.json";
// @ts-expect-error — build-time script, no type declarations
import { applyOverrides, mergeCustom } from "../scripts/build-exercise-db.cjs";

type Entry = { id: string; is_custom: boolean; [k: string]: unknown };

describe("mergeCustom (T2-1 · T2-2)", () => {
  const upstream = [
    { id: "walking_treadmill", primary_muscles: ["quadriceps"], secondary_muscles: [], is_custom: false },
    { id: "zercher_squats", primary_muscles: ["quadriceps"], secondary_muscles: [], is_custom: false },
  ];

  it("T2-1 네트워크 없이 upstream 픽스처에 병합 — is_custom true · 칸 값이 D57 A15 · source 는 싣지 않는다", () => {
    const out = mergeCustom(upstream, custom) as Entry[];
    expect(out.map((e) => e.id)).toEqual([...custom.map((e) => e.id), "walking_treadmill", "zercher_squats"].sort());
    expect(out.find((e) => e.id === "mymountain")).toEqual({
      id: "mymountain",
      name: "MyMountain",
      name_ko: "마이마운틴",
      modality: "cardio",
      default_metric: "duration",
      equipment: "machine",
      category: "cardio",
      mechanic: null,
      force: null,
      level: "beginner",
      primary_muscles: ["glutes"],
      secondary_muscles: ["hamstrings", "calves", "quadriceps", "lower back"],
      contraindication_tags: ["glutes", "hamstrings", "calves", "quadriceps", "lower back"],
      is_custom: true,
    });
  });

  it("T2-2 upstream 과 id 가 겹치면 멈춘다", () => {
    expect(() => mergeCustom(upstream, [{ ...custom[0], id: "walking_treadmill" }])).toThrow(/collides/);
  });

  it("커밋된 exercises.json 에 병합 결과가 들어 있다 — 커스텀은 원천에 있는 것뿐", () => {
    const vendored = catalogue as Entry[];
    const upstreamPart = vendored.filter((e) => !e.is_custom);
    expect(mergeCustom(applyOverrides(upstreamPart, overrides), custom)).toEqual(vendored);
  });
});
