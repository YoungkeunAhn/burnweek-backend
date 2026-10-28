import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BEGINNER_LOAD_INCREMENT_KG, BEGINNER_WORKING_REP_RANGE, HAND_LOAD } from "../src/data/constants";
// @ts-expect-error — build-time script, no type declarations
import { nameKo } from "../scripts/name-ko.cjs";
import {
  EXERCISES,
  byId,
  candidateIdsFor,
  canonicalId,
  capGroupsOf,
  catalogueInvariants,
  contraindicationTags,
  find,
  resolve,
} from "../src/data/exercises";
import { CAP_GROUPS, MEV_ANCHORS, WEEKLY_VOLUME_CAPS, incrementForMuscles } from "../src/data/constants";
import { checkPerformedSession } from "../src/schemas/validate";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import draftPlanSchema from "../src/schemas/draft-plan.schema.json";
import weeklyPlanSchema from "../src/schemas/weekly-plan.schema.json";
import performedSessionSchema from "../src/schemas/performed-session.schema.json";

describe("vendored catalogue (T1.2)", () => {
  it("loads and holds its invariants", () => {
    expect(catalogueInvariants()).toEqual([]);
    expect(EXERCISES.length).toBeGreaterThan(800);
  });

  it("keeps every id a lowercase slug", () => {
    // Ids travel through plans, logs and prompts; a stray TitleCase or hyphen
    // would mean two spellings of the same exercise.
    const bad = EXERCISES.filter((e) => !/^[a-z0-9_]{1,64}$/.test(e.id));
    expect(bad.map((e) => e.id)).toEqual([]);
  });

  it("names every exercise in Korean (D13)", () => {
    const missing = EXERCISES.filter((e) => !e.name_ko || e.name_ko.trim().length === 0);
    expect(missing.map((e) => e.id)).toEqual([]);
    // The composer leaves `[?token]` where the glossary has a hole; the build
    // script aborts on those, so none may ever reach the vendored data.
    expect(EXERCISES.filter((e) => e.name_ko.includes("[?")).map((e) => e.id)).toEqual([]);
    // No Latin letters at all beyond the handful we keep on purpose. Checking
    // both cases matters: an all-uppercase regression like "BARBELL SQUAT" would
    // slip past a lowercase-only test.
    const ALLOWED_LATIN = /EZ|SMR|JM|[VTZ]/g;
    const stray = EXERCISES.filter((e) => /[A-Za-z]/.test(e.name_ko.replace(ALLOWED_LATIN, "")));
    expect(stray.map((e) => `${e.id}=${e.name_ko}`)).toEqual([]);
  });

  it("keeps the vendored name_ko in sync with the glossary", () => {
    // Guards against hand-editing exercises.json: every stored name must be
    // exactly what the composer produces from the English name today. Custom
    // entries (D57 A15) carry their own `name_ko` from `scripts/custom-exercises.json`.
    const drifted = EXERCISES.filter((e) => !e.is_custom && nameKo(e.name) !== e.name_ko);
    expect(drifted.map((e) => `${e.id}: ${e.name_ko} != ${nameKo(e.name)}`)).toEqual([]);
  });

  it("translates known names the documented way", () => {
    expect(byId("barbell_squat")?.name_ko).toBe("바벨 스쿼트");
    expect(byId("dumbbell_bench_press")?.name_ko).toBe("덤벨 벤치프레스");
    expect(byId("3_4_sit_up")?.name_ko).toBe("3/4 싯업");
    expect(byId("romanian_deadlift")?.name_ko).toBe("루마니안 데드리프트");
  });

  it("does not regress the mistranslations codex caught", () => {
    // Each of these was wrong once: bend→밴드다운, back(부위)→백, quad→대퇴사두,
    // "pull through"/"around the worlds" truncated by dropped grammar words.
    expect(byId("barbell_side_bend")?.name_ko).toBe("바벨 사이드 벤드");
    expect(byId("upper_back_stretch")?.name_ko).toBe("상부 등 스트레칭");
    expect(byId("chair_lower_back_stretch")?.name_ko).toBe("의자 허리 스트레칭");
    expect(byId("quad_stretch")?.name_ko).toBe("쿼드 스트레칭");
    expect(byId("pull_through")?.name_ko).toBe("풀스루");
    expect(byId("around_the_worlds")?.name_ko).toBe("어라운드 더 월드");
    // Possessive phrases only match because phrase keys go through the same
    // tokenizer as the names.
    expect(byId("conans_wheel")?.name_ko).toBe("코난스 휠");
    for (const forbidden of ["밴드다운", "상부 백", "하부 백"]) {
      expect(EXERCISES.filter((e) => e.name_ko.includes(forbidden)).map((e) => e.id)).toEqual([]);
    }
  });

  it("has no duplicate or unreachable glossary keys", () => {
    const source = readFileSync(new URL("../scripts/name-ko-glossary.cjs", import.meta.url), "utf8");
    // Duplicate object keys are silently collapsed at parse time, so check the text.
    const keys = [...source.matchAll(/^\s{2}"?([a-z0-9 _']+)"?:/gm)].map((m) => m[1]);
    const duplicates = keys.filter((k, i) => keys.indexOf(k) !== i);
    expect(duplicates).toEqual([]);
    // A key with an underscore can never match: the tokenizer splits on it.
    expect(keys.filter((k) => k.includes("_"))).toEqual([]);
  });

  it("canonicalises upstream TitleCase ids", () => {
    expect(canonicalId("3_4_Sit-Up")).toBe("3_4_sit_up");
    expect(byId("3_4_sit_up")?.name).toBe("3/4 Sit-Up");
  });
});

describe("lookup of model-invented ids (MiniMax POC finding)", () => {
  it("resolves an exact id", () => {
    expect(resolve("Barbell_Squat")?.id).toBe("barbell_squat");
  });

  it("resolves a superset id the model made up", () => {
    expect(resolve("barbell_back_squat")?.id).toBe("barbell_squat");
  });

  it("prefers the longest catalogue match", () => {
    // `barbell_deadlift` (2 tokens) and `stiff_legged_barbell_deadlift` (4) both
    // fit the request; the longer one is the better reading.
    expect(resolve("heavy_stiff_legged_barbell_deadlift")?.id).toBe("stiff_legged_barbell_deadlift");
  });

  it("refuses to guess when two candidates tie", () => {
    // Regression: `barbell_deadlift` and `romanian_deadlift` both match two
    // tokens, so this used to resolve alphabetically to `barbell_deadlift` — a
    // different exercise. Ambiguity must fail into the repair retry instead.
    expect(resolve("barbell_romanian_deadlift")).toBeUndefined();
  });

  it("returns undefined for an unknown exercise rather than inventing one", () => {
    expect(resolve("moon_gravity_curl")).toBeUndefined();
    expect(resolve("")).toBeUndefined();
  });
});

describe("filters (T1.2 AC: 운동 조회·근육군/장비 필터)", () => {
  it("filters by primary muscle and equipment", () => {
    const hits = find({ primaryMuscles: ["quadriceps"], equipment: ["barbell"] });
    expect(hits.length).toBeGreaterThan(0);
    for (const e of hits) {
      expect(e.primary_muscles).toContain("quadriceps");
      expect(e.equipment).toBe("barbell");
    }
  });

  it("filters by modality", () => {
    const cardio = find({ modality: "cardio" });
    expect(cardio.length).toBeGreaterThan(0);
    expect(cardio.every((e) => e.modality === "cardio")).toBe(true);
  });

  it("excludes contraindicated muscles, secondary loading included", () => {
    const hits = find({ primaryMuscles: ["chest"], excludeMuscles: ["shoulders"] });
    expect(hits.length).toBeGreaterThan(0);
    for (const e of hits) {
      expect(contraindicationTags(e)).not.toContain("shoulders");
    }
  });

  it("maps muscles onto the nine cap groups", () => {
    const squat = byId("barbell_squat");
    expect(squat).toBeDefined();
    expect(capGroupsOf(squat!)).toContain("quads");
    // 17-value taxonomy members with no ceiling stay uncapped (design §3.2.1).
    const crunch = byId("3_4_sit_up");
    expect(capGroupsOf(crunch!)).toEqual([]);
  });
});

describe("programming constants (T1.3, design §3.2.1)", () => {
  it("matches the design table exactly", () => {
    expect(WEEKLY_VOLUME_CAPS).toEqual({
      chest: 12,
      back: 14,
      quads: 12,
      hamstrings: 10,
      glutes: 12,
      shoulders: 12,
      biceps: 10,
      triceps: 10,
      calves: 12,
    });
  });

  it("pins MEV anchors to the research/03 lower bounds", () => {
    // 가슴 8 · 등(광배 8 / 로우 6 → 보수적으로 6) · 대퇴사두 6–10 → 6
    // 햄스트링 4–6 → 4 · 둔근 4 · 측/후면 삼각 6–8 → 6 · 이두 6–8 → 6
    // 삼두 4–6 → 4 · 종아리 6–8 → 6
    expect(MEV_ANCHORS).toEqual({
      chest: 8,
      back: 12, // 광배 + 중부 등(D104 ④ 당기기 ≥ 밀기)
      quads: 6,
      hamstrings: 4,
      glutes: 4,
      shoulders: 6,
      biceps: 6,
      triceps: 4,
      calves: 6,
    });
  });

  it("keeps every MEV anchor at or below its cap", () => {
    for (const group of CAP_GROUPS) {
      expect(MEV_ANCHORS[group]).toBeLessThanOrEqual(WEEKLY_VOLUME_CAPS[group]);
    }
  });

  it("uses +2.5kg upper / +5kg lower increments, classified by muscle", () => {
    expect(incrementForMuscles(["chest"])).toBe(2.5);
    expect(incrementForMuscles(["biceps"])).toBe(2.5);
    expect(incrementForMuscles(["quadriceps"])).toBe(5);
    expect(incrementForMuscles(["calves"])).toBe(5);
    // `lower back` rolls up to the back *cap* group but is lower-body for load.
    expect(incrementForMuscles(["lower back"])).toBe(5);
  });

  // T1-12 (040): design §3.2.1 의 입문자 행과 상수가 같다.
  it("pins the beginner preset constants to design §3.2.1 (D55 ①)", () => {
    expect(BEGINNER_WORKING_REP_RANGE).toEqual({ min: 10, max: 15 });
    expect(BEGINNER_LOAD_INCREMENT_KG).toEqual({ upper: 1.25, lower: 2.5 });
    expect(HAND_LOAD).toEqual({ incrementKg: 2, stepKg: 1 });
    expect(incrementForMuscles(["lower back"], "barbell", "beginner")).toBe(2.5);
    expect(incrementForMuscles(["chest"], "barbell", "beginner")).toBe(1.25);
  });
});

describe("three plan schemas are valid draft2020-12 (T1.1 AC)", () => {
  it("passes the metaschema", () => {
    const ajv = new Ajv2020({ strict: false });
    addFormats(ajv);
    for (const schema of [draftPlanSchema, weeklyPlanSchema, performedSessionSchema]) {
      expect({ title: (schema as { title: string }).title, valid: ajv.validateSchema(schema) }).toEqual({
        title: (schema as { title: string }).title,
        valid: true,
      });
    }
  });
});

describe("PerformedSession v1 validator (T1.1)", () => {
  const valid = {
    schema_version: "1.0",
    session_id: "s1",
    plan_id: "p1",
    date: "2026-08-10",
    day_index: 1,
    completion: "completed",
    exercises: [
      {
        exercise_id: "barbell_squat",
        modality: "strength",
        sets: [{ set_number: 1, set_kind: "working", actual_reps: 8, actual_load_kg: 60 }],
      },
    ],
  };

  it("accepts a well-formed session", () => {
    expect(checkPerformedSession(valid).ok).toBe(true);
  });

  it("rejects a set mixing strength and cardio fields (oneOf, §B3)", () => {
    const mixed = structuredClone(valid);
    (mixed.exercises[0].sets[0] as Record<string, unknown>).cardio = {
      modality: "cycling",
      duration_min: 20,
    };
    expect(checkPerformedSession(mixed).ok).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { completion, ...withoutCompletion } = valid;
    expect(completion).toBe("completed");
    expect(checkPerformedSession(withoutCompletion).ok).toBe(false);
  });

  it("resolves a plural id the model wrote in the singular", () => {
    // Live MiniMax run asked for `seated_cable_row`; the catalogue has the plural.
    expect(resolve("seated_cable_row")?.id).toBe("seated_cable_rows");
  });

  it("resolves a word-split id the model wrote with underscores", () => {
    // Golden run asked for `push_ups`; the catalogue id is one word. Without this
    // the whole slot was dropped and chest volume fell below the beginner MEV.
    expect(resolve("push_ups")?.id).toBe("pushups");
    expect(resolve("pull_ups")?.id).toBe("pullups");
  });

  it("still prefers an exact token match over a stemmed one", () => {
    // `squats_with_bands` and `squat_with_bands` both exist; stemming alone would
    // tie them and drop both.
    for (const id of ["squats_with_bands", "squat_with_bands"]) {
      if (byId(id)) expect(resolve(id)?.id).toBe(id);
    }
  });
});

describe("candidate ids offered to the LLM", () => {
  it("covers every cap group for a full-gym profile", () => {
    const ids = candidateIdsFor({
      equipment: ["barbell", "dumbbell", "cable", "machine", "body only"],
      environment: "full_gym",
    });
    const covered = new Set(ids.flatMap((id) => capGroupsOf(byId(id)!)));
    for (const group of CAP_GROUPS) expect(covered.has(group)).toBe(true);
  });

  it("offers only body-only work to a bodyweight_only profile", () => {
    // Regression: an empty equipment list used to mean "no filter", so a home
    // trainee was offered barbell lifts they cannot perform.
    const ids = candidateIdsFor({ equipment: [], environment: "bodyweight_only" });
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(byId(id)!.equipment).toBe("body only");
  });

  it("never returns an empty list, even for unknown equipment", () => {
    const ids = candidateIdsFor({ equipment: ["antigravity boots"], environment: "minimal" });
    expect(ids.length).toBeGreaterThan(0);
  });

  it("excludes cardio and stretching — those are placed by code", () => {
    const ids = candidateIdsFor({ equipment: ["barbell", "dumbbell"], environment: "home_gym" });
    for (const id of ids) {
      const exercise = byId(id)!;
      expect(exercise.modality).not.toBe("cardio");
      expect(exercise.category).not.toBe("stretching");
    }
  });
});

describe("입문자 후보 프리셋 (D55 ① · 040 T1-1~T1-4)", () => {
  const GYM = ["barbell", "dumbbell", "cable", "machine", "kettlebells", "bands", "e-z curl bar"];
  const beginner = { equipment: GYM, environment: "full_gym", experience_level: "beginner" };
  const novice = { equipment: GYM, environment: "full_gym", experience_level: "novice_intermediate" };
  const equipmentOf = (id: string) => byId(id)!.equipment;

  it("drops expert and `other`, and puts machines·cables·dumbbells before barbells (T1-1)", () => {
    const ids = candidateIdsFor(beginner);
    expect(ids.length).toBeGreaterThan(30);
    for (const id of ids) {
      expect(byId(id)!.level).not.toBe("expert");
      expect(equipmentOf(id)).not.toBe("other");
    }
    const equipment = ids.map(equipmentOf);
    // 🔴 그룹 안 비교 키만 바꾸고 마지막 `.sort()` 를 두면 id 순으로 돌아가
    // 앞 30개에 barbell 이 10개 넘게 선다(§1 ② 재현값 35/95).
    expect(equipment.slice(0, 30).filter((e) => e === "barbell")).toHaveLength(0);
    expect(equipment.indexOf("barbell")).toBeGreaterThan(equipment.lastIndexOf("dumbbell"));
    expect(equipment.indexOf("barbell")).toBeGreaterThan(equipment.lastIndexOf("machine"));
    // 바벨이 통째로 사라지면 안 된다 — D55 ① 「바벨 복합은 세션당 1개까지」는 고를 바벨이 있다는 뜻이다.
    expect(equipment.filter((e) => e === "barbell").length).toBeGreaterThanOrEqual(15);
    for (const id of ["barbell_squat", "barbell_bench_press_medium_grip"]) expect(ids).toContain(id);
    // 그래도 모든 상한 그룹은 덮여야 한다 — 정렬이 커버리지를 깨지 않는다.
    const covered = new Set(ids.flatMap((id) => capGroupsOf(byId(id)!)));
    for (const group of CAP_GROUPS) expect(covered.has(group)).toBe(true);
  });

  it("keeps last week's lifts in the list whatever the cut, but never past the equipment filter (T1-2)", () => {
    const keep = ["barbell_squat", "barbell_bench_press_medium_grip"];
    const ids = candidateIdsFor(beginner, 10, keep);
    for (const id of keep) expect(ids).toContain(id);
    // 카탈로그에 없는 id · 장비 필터 밖 id 는 붙지 않는다.
    const bodyweight = candidateIdsFor({ equipment: [], environment: "bodyweight_only", experience_level: "beginner" }, 10, [
      "no_such_id",
      "barbell_squat",
    ]);
    expect(bodyweight).not.toContain("no_such_id");
    expect(bodyweight).not.toContain("barbell_squat");
  });

  it("keeps expert out of the body-only fallback too (codex R1 #5)", () => {
    const ids = candidateIdsFor({ equipment: ["other"], environment: "minimal", experience_level: "beginner" });
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(byId(id)!.level).not.toBe("expert");
  });

  it("keeps the equipment filter ahead of the preset — bodyweight users get body-only work (T1-3)", () => {
    const ids = candidateIdsFor({ equipment: [], environment: "bodyweight_only", experience_level: "beginner" });
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(equipmentOf(id)).toBe("body only");
  });

  it("leaves the novice list byte-for-byte as before (T1-4)", () => {
    const ids = candidateIdsFor(novice);
    const legacy = candidateIdsFor({ equipment: GYM, environment: "full_gym" });
    expect(ids).toEqual(legacy);
    expect(ids.every((id, i) => i === 0 || ids[i - 1] < id)).toBe(true); // id 순
    expect(ids.some((id) => byId(id)!.level === "expert")).toBe(true); // expert 도 그대로(§1 ② 실측 3개)
  });
});
