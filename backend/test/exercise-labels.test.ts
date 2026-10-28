import { describe, expect, it } from "vitest";
import labels from "../src/data/exercise-labels.json";
import { byId } from "../src/data/exercises";
import { createExerciseMatcher } from "../src/data/exercise-search";

describe("exercise labels and identity-preserving search", () => {
  it("rejects stale IDs or English-name mappings in the curated source", () => {
    for (const [id, entry] of Object.entries(labels)) {
      expect(byId(id), id).toMatchObject({ name: entry.english, name_ko: entry.name_ko });
      expect(entry.name_ko.trim(), id).not.toBe("");
    }
  });

  it.each([
    ["이너타이", "thigh_adductor"], ["허벅지 내전근", "thigh_adductor"],
    ["아웃타이", "thigh_abductor"], ["밴드이너타이", "band_hip_adductions"],
    ["펙덱", "butterfly"], ["버터플라이", "butterfly"],
    ["사레레", "side_lateral_raise"], ["런닝머신", "running_treadmill"],
    ["천국의계단", "step_mill"], ["딥스", "bench_dips"],
    ["외회전로테이션", "external_rotation"], ["ㅇㄴㅌㅇ", "thigh_adductor"],
  ])("finds %s in both catalogue and server candidate search", (query, id) => {
    const e = byId(id)!;
    expect(createExerciseMatcher(query)([e.name_ko, e.id])).toBe(true);
    expect(createExerciseMatcher(query)([e.name_ko, e.id, e.name])).toBe(true);
  });

  it("does not equate different exercises or turn punctuation into match-all", () => {
    expect(createExerciseMatcher("이너타이")(["아웃타이", "thigh_abductor"])).toBe(false);
    expect(createExerciseMatcher("사레레")(["리버스 펙덱 플라이", "reverse_machine_flyes"])).toBe(false);
    expect(createExerciseMatcher("허벅지 내전근")(["임의 종목", "custom_thigh_adductor"])).toBe(false);
    expect(createExerciseMatcher("---")(["이너타이", "thigh_adductor"])).toBe(false);
    expect(createExerciseMatcher("   ")(["이너타이", "thigh_adductor"])).toBe(true);
  });
});
