/** 맨몸 도구(`requires`) — 운동목록 개선 실행 그래프 N1 T1-1~T1-4 · 백로그 02 §2·§3, 04 §3·§4. */
import { describe, expect, it } from "vitest";
import catalogue from "../src/data/exercises.json";
import overrides from "../scripts/catalog-overrides.json";
// @ts-expect-error — build-time script, no type declarations
import { applyOverrides, mergeCustom, TOOLS } from "../scripts/build-exercise-db.cjs";
import { byId, find, profileFilter, type Exercise } from "../src/data/exercises";
import { allowedGeneratedExerciseIds, generatedPlanExerciseProblems } from "../src/generation/exercise-policy";
import { buildUserContext } from "../src/generation/prompt";
import { GOLDEN_PROFILES } from "./fixtures/golden-profiles";
import gymBefore from "./fixtures/gym-candidates-before-n1.json";

const BODYWEIGHT = { environment: "bodyweight_only", experience_level: "beginner", equipment: [] as string[] };

describe("requires — 맨몸 후보", () => {
  it("T1-1 맨몸·도구 없음 후보에 requires 종목 0 — 생성 후보와 편집·부상 대체(find) 둘 다", () => {
    for (const experience_level of ["beginner", "intermediate"]) {
      const ids = allowedGeneratedExerciseIds({ ...BODYWEIGHT, experience_level } as never);
      expect(ids.filter((id) => byId(id)?.requires)).toEqual([]);
    }
    expect(find(profileFilter(BODYWEIGHT)).filter((e) => e.requires).map((e) => e.id)).toEqual([]);
  });

  it("보유 도구에 있으면 requires 종목도 든다 — 칩이 생기면 그대로 쓴다", () => {
    const ids = find(profileFilter({ ...BODYWEIGHT, equipment: ["pull_up_bar"] })).map((e) => e.id);
    expect(ids).toContain("pullups");
    expect(ids).not.toContain("dips_triceps_version");
  });

  it("T1-2 맨몸 후보에 푸시업·인버티드 로우·런지·글루트 브릿지가 있다", () => {
    const ids = allowedGeneratedExerciseIds(BODYWEIGHT as never);
    for (const id of ["pushups", "table_inverted_row", "bodyweight_lunge", "butt_lift_bridge"]) expect(ids).toContain(id);
  });

  it("T1-3 02 §2 표의 도구 종목에 requires 가 채워졌다 · 값은 enum 안", () => {
    const table = [
      "pullups", "chin_up", "v_bar_pullup", "wide_grip_rear_pull_up", "hanging_leg_raise", "hanging_pike", "gorilla_chin_crunch",
      "wind_sprints", "dips_triceps_version", "body_tricep_press", "bench_dips", "bench_jump", "push_ups_with_feet_elevated",
      "incline_push_up", "incline_push_up_close_grip", "incline_push_up_medium", "incline_push_up_reverse_grip", "incline_push_up_wide",
      "flat_bench_leg_pull_in", "flat_bench_lying_leg_raise", "seated_flat_bench_leg_pull_in", "seated_leg_tucks",
      "decline_crunch", "decline_oblique_crunch", "decline_reverse_crunch", "flutter_kicks",
      "hyperextensions_with_no_hyperextension_bench", "natural_glute_ham_raise", "step_up_with_knee_raise",
      "close_grip_push_up_off_of_a_dumbbell", "crunch_legs_on_exercise_ball", "handstand_push_ups",
    ];
    expect(table.filter((id) => !byId(id)?.requires?.length)).toEqual([]);
    const used = (catalogue as Exercise[]).flatMap((e) => e.requires ?? []);
    expect(used.filter((t) => !TOOLS.includes(t))).toEqual([]);
  });

  it("T1-4 헬스장 후보에는 requires 가 걸리지 않고 맨몸용 종목이 끼지 않는다", () => {
    for (const item of GOLDEN_PROFILES.filter((g) => g.profile.environment === "full_gym")) {
      const ids = allowedGeneratedExerciseIds(item.profile);
      expect(ids.filter((id) => byId(id)?.bodyweight_pool), item.id).toEqual([]);
    }
    const gym = allowedGeneratedExerciseIds({ environment: "full_gym", experience_level: "intermediate", equipment: ["barbell", "dumbbell", "cable", "machine", "body only"] } as never);
    expect(gym).toContain("dumbbell_lunges");
    // 장비 제한 없는 헬스장은 옛 `other` 종목을 받았다 — 태그 정정 뒤에도 후보·직전 종목 유지가 같다(codex N1 R1).
    const open = { environment: "full_gym", experience_level: "intermediate", equipment: [] as string[] };
    expect(allowedGeneratedExerciseIds(open as never, ["mountain_climbers"])).toContain("mountain_climbers");
    expect(allowedGeneratedExerciseIds({ ...open, equipment: ["other"] } as never, ["mountain_climbers"])).toContain("mountain_climbers");
    expect(allowedGeneratedExerciseIds(open as never).filter((id) => byId(id)?.is_custom && byId(id)?.bodyweight_pool)).toEqual([]);
    expect(gym.some((id) => byId(id)?.requires)).toBe(true);
  });

  it("T1-4 헬스장 후보(프리셋·빈 장비·other·keepIds)가 N1 이전과 순서까지 같다", () => {
    for (const [name, c] of Object.entries(gymBefore.cases)) {
      expect(allowedGeneratedExerciseIds(c.profile as never, gymBefore.keep), name).toEqual(c.ids);
    }
  });

  it("헬스장 후보로 준 정정 종목을 생성 검증이 거절하지 않는다(codex N1 R3)", () => {
    const profile = { environment: "full_gym", experience_level: "beginner", equipment: ["other"] } as never;
    const ids = allowedGeneratedExerciseIds(profile, ["mountain_climbers"]);
    expect(ids).toContain("mountain_climbers");
    const plan = { week: [{ exercises: [{ exercise_id: "mountain_climbers" }] }] };
    expect(generatedPlanExerciseProblems(plan, profile, ids)).toEqual([]);
    // 편집·부상 대체(find)도 같은 판정이다(codex N1 R4).
    expect(find(profileFilter({ environment: "full_gym", equipment: ["other"] })).map((e) => e.id)).toContain("bodyweight_walking_lunge");
  });

  it("태그 정정 — other→body only 는 modality 도 bodyweight, stretching 오분류는 strength", () => {
    expect(byId("bodyweight_walking_lunge")).toMatchObject({ equipment: "body only", modality: "bodyweight" });
    expect(byId("split_squats")).toMatchObject({ equipment: "body only", category: "strength" });
  });

  it("정정이 없는 id 를 가리키거나 enum 밖 도구면 빌드가 멈춘다", () => {
    const upstream = [{ id: "pushups", equipment: "body only", category: "strength" }];
    expect(() => applyOverrides(upstream, { retag: { gone: {} }, requires: {} })).toThrow(/not in catalogue/);
    expect(() => applyOverrides(upstream, { retag: {}, requires: { pushups: ["rope"] } })).toThrow(/unknown tool/);
    expect(() => mergeCustom([], [{ id: "x", primary_muscles: [], secondary_muscles: [], requires: ["rope"] }])).toThrow(/unknown tool/);
    expect(Object.keys(overrides.requires).length).toBeGreaterThan(0);
  });

  it("맨몸 프로필에만 환경 태그가 실린다(프롬프트 규칙 분기)", () => {
    const req = (profile: object) => ({ profile, week_start_date: "2026-10-19", prior_logs: [] }) as never;
    const bodyweight = GOLDEN_PROFILES.find((g) => g.profile.environment === "bodyweight_only")!.profile;
    const gym = GOLDEN_PROFILES.find((g) => g.profile.environment === "full_gym")!.profile;
    expect(buildUserContext(req(bodyweight))).toContain("<environment_preset>bodyweight_only</environment_preset>");
    expect(buildUserContext(req(gym))).not.toContain("<environment_preset>");
  });
});
