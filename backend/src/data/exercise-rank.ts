/**
 * 움직임 패턴별 큐레이션 순위(P1 · [ADR-0025] · [D104] ④). 앞일수록 먼저 권한다.
 *
 * 근거: 한국 초보 루틴의 머신 고정 세트(체스트프레스·랫풀다운·숄더프레스·레그프레스·레그컬·
 * 레그익스텐션)와 영어권 프로그램의 슬롯 대표 종목 — 백로그 운동목록 12 §1·§3, 원자료 12-research/A·B·D.
 * 같은 패턴 안에서 머신 → 덤벨 → 바벨 → 맨몸 순으로 두고, 입문자 정렬은 `slots.ts` 가 장비로 한 번 더 건다.
 * 여기 없는 종목은 `slots.ts` `patternOf` 의 카탈로그 규칙으로 뒤에 붙는다.
 */
export type Pattern =
  | "squat"
  | "hinge"
  | "lunge"
  | "glute"
  | "h_push"
  | "v_push"
  | "h_pull"
  | "v_pull"
  | "chest_iso"
  | "lat_raise"
  | "rear_delt"
  | "biceps"
  | "triceps"
  | "leg_curl"
  | "leg_ext"
  | "calf"
  | "abduction"
  | "core";

export const PATTERN_RANK: Record<Pattern, string[]> = {
  squat: [
    "leg_press", "hack_squat", "smith_machine_squat", "goblet_squat", "dumbbell_squat", "barbell_squat",
    "front_barbell_squat", "bodyweight_squat", "wide_squat", "narrow_squat",
  ],
  hinge: [
    "stiff_legged_dumbbell_deadlift", "romanian_deadlift", "smith_machine_stiff_legged_deadlift", "pull_through",
    "barbell_deadlift", "good_morning", "bodyweight_good_morning", "hyperextensions_with_no_hyperextension_bench",
  ],
  lunge: [
    "dumbbell_lunges", "split_squat_with_dumbbells", "dumbbell_rear_lunge", "dumbbell_step_ups", "smith_single_leg_split_squat",
    "barbell_lunge", "bodyweight_lunge", "split_squats", "reverse_lunge_knee_up", "chair_step_up",
  ],
  glute: ["barbell_hip_thrust", "barbell_glute_bridge", "butt_lift_bridge", "single_leg_glute_bridge"],
  h_push: [
    "leverage_chest_press", "machine_bench_press", "dumbbell_bench_press", "incline_dumbbell_press", "cable_chest_press",
    "smith_machine_bench_press", "barbell_bench_press_medium_grip", "barbell_incline_bench_press_medium_grip",
    "leverage_incline_chest_press", "pushups", "knee_push_up", "incline_push_up", "wall_push_up", "push_ups_with_feet_elevated",
  ],
  v_push: [
    "machine_shoulder_military_press", "leverage_shoulder_press", "dumbbell_shoulder_press", "seated_dumbbell_press",
    "arnold_dumbbell_press", "cable_shoulder_press", "barbell_shoulder_press", "standing_military_press",
  ],
  h_pull: [
    "seated_cable_rows", "leverage_iso_row", "leverage_high_row", "one_arm_dumbbell_row", "bent_over_two_dumbbell_row",
    "dumbbell_incline_row", "bent_over_barbell_row", "t_bar_row_with_handle", "inverted_row", "table_inverted_row", "towel_door_row",
  ],
  v_pull: [
    "wide_grip_lat_pulldown", "close_grip_front_lat_pulldown", "underhand_cable_pulldowns", "v_bar_pulldown",
    "band_assisted_pull_up", "chin_up", "pullups",
  ],
  chest_iso: ["butterfly", "dumbbell_flyes", "cable_crossover", "incline_dumbbell_flyes", "flat_bench_cable_flyes"],
  lat_raise: ["side_lateral_raise", "cable_seated_lateral_raise", "seated_side_lateral_raise", "one_arm_side_laterals"],
  rear_delt: ["face_pull", "reverse_flyes", "cable_rear_delt_fly", "seated_bent_over_rear_delt_raise"],
  biceps: [
    "dumbbell_bicep_curl", "hammer_curls", "machine_bicep_curl", "standing_biceps_cable_curl", "ez_bar_curl",
    "barbell_curl", "incline_dumbbell_curl", "preacher_curl",
  ],
  triceps: [
    "triceps_pushdown", "triceps_pushdown_rope_attachment", "machine_triceps_extension", "cable_rope_overhead_triceps_extension",
    "standing_dumbbell_triceps_extension", "ez_bar_skullcrusher", "close_grip_barbell_bench_press", "bench_dips",
    "push_ups_close_triceps_position",
  ],
  leg_curl: ["lying_leg_curls", "seated_leg_curl", "standing_leg_curl", "ball_leg_curl"],
  leg_ext: ["leg_extensions", "single_leg_leg_extension"],
  calf: ["standing_calf_raises", "seated_calf_raise", "calf_press_on_the_leg_press_machine", "standing_dumbbell_calf_raise"],
  abduction: ["thigh_abductor", "side_step"],
  core: [
    "plank", "crunches", "ab_crunch_machine", "cable_crunch", "reverse_crunch", "dead_bug", "flat_bench_lying_leg_raise",
    "hanging_leg_raise", "pallof_press",
  ],
};
