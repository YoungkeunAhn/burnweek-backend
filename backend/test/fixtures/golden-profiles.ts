/**
 * Golden-set profiles (001 T5.2). Representative coverage of the Phase 1 input
 * space: 2–6 training days, every environment, every cardio preference, injuries
 * present and absent, both experience levels, and a low-risk flag.
 *
 * Each profile has a committed DraftPlan fixture in `golden-drafts.json`, produced
 * once by the live model (`scripts/build-golden-drafts.cjs`). The golden test then
 * runs offline and deterministically — a failure means *our* engine changed, not
 * that the model had a bad day.
 */
import type { UserProfile } from "../../src/generation/types";

export interface GoldenProfile {
  id: string;
  why: string;
  profile: UserProfile;
  /** Prior logs to feed the expansion, if this case exercises the feedback loop. */
  priorLogs?: unknown[];
  weekNumber?: number;
}

function base(overrides: Partial<UserProfile>): UserProfile {
  return {
    goals: ["build_muscle"],
    experience_level: "beginner",
    days_per_week: 3,
    session_len_min: 45,
    environment: "full_gym",
    equipment: ["barbell", "dumbbell", "cable", "machine", "body only"],
    cardio_pref: "maintain_health",
    cardio_modalities: [],
    injuries: [],
    red_flags: { hard: [], low_risk: [] },
    ...overrides,
  };
}

/** PerformedSession v1 log: every working set at the top of the rep range (beginner 상단 15 — D55 ①). */
function topRepsLog(exerciseId: string, kg: number, opts: { pain?: boolean; failed?: boolean } = {}) {
  return [
    {
      schema_version: "1.0",
      session_id: "golden-s1",
      plan_id: "golden-w1",
      date: "2026-08-10",
      day_index: 0,
      completion: "completed",
      exercises: [
        {
          exercise_id: exerciseId,
          modality: "strength",
          sets: [
            { set_number: 1, set_kind: "warmup", actual_reps: 5, actual_load_kg: kg / 2 },
            {
              set_number: 2,
              set_kind: "working",
              actual_reps: opts.failed ? 6 : 15,
              actual_load_kg: kg,
              ...(opts.failed ? { failed: true } : {}),
              ...(opts.pain ? { pain_flag: true } : {}),
            },
            { set_number: 3, set_kind: "working", actual_reps: 15, actual_load_kg: kg },
          ],
        },
      ],
    },
  ];
}

export const GOLDEN_PROFILES: GoldenProfile[] = [
  {
    id: "beginner-2day-fullgym",
    why: "minimum training frequency (2 days → full_body)",
    profile: base({ days_per_week: 2 }),
  },
  {
    id: "beginner-3day-cardio-none",
    why: "no cardio at all — S-GEN-6 must place nothing",
    profile: base({ days_per_week: 3, cardio_pref: "none" }),
  },
  {
    id: "beginner-4day-upperlower",
    why: "4 days → upper_lower split",
    profile: base({ days_per_week: 4, goals: ["lose_fat"], cardio_pref: "fat_loss" }),
  },
  {
    id: "novice-5day-ppl-conditioning",
    why: "5 days → PPL, and conditioning adds a HIIT session",
    profile: base({
      days_per_week: 5,
      experience_level: "novice_intermediate",
      cardio_pref: "conditioning",
      cardio_modalities: ["rowing", "cycling"],
    }),
  },
  {
    id: "beginner-6day-ppl",
    why: "maximum training frequency, cardio has to fit around it",
    profile: base({ days_per_week: 6, goals: ["general_fitness"] }),
  },
  {
    id: "beginner-bodyweight-only",
    why: "no equipment — candidate ids must stay body-only",
    profile: base({ days_per_week: 3, environment: "bodyweight_only", equipment: [] }),
  },
  {
    id: "beginner-home-gym-dumbbells",
    why: "limited equipment (dumbbells + bands only)",
    profile: base({ days_per_week: 3, environment: "home_gym", equipment: ["dumbbell", "bands"] }),
  },
  {
    id: "beginner-minimal-shoulder-injury",
    why: "injury exclusion + substitution (S-GEN-4)",
    profile: base({
      days_per_week: 3,
      environment: "minimal",
      equipment: ["dumbbell", "body only"],
      injuries: [{ region: "shoulders" }],
    }),
  },
  {
    id: "beginner-lowrisk-flag",
    why: "low-risk flag → warning path, generation still succeeds (FR-SAFE-4)",
    profile: base({
      days_per_week: 3,
      red_flags: { hard: [], low_risk: ["managed_hypertension", "mild_joint_discomfort"] },
    }),
  },
  {
    id: "week2-progression-increase",
    why: "feedback loop: top reps hit → increase (S-GEN-10)",
    profile: base({ days_per_week: 3 }),
    priorLogs: topRepsLog("barbell_squat", 60),
    weekNumber: 2,
  },
  {
    id: "week2-progression-pain",
    why: "feedback loop: pain logged → decrease or substitute (S-GEN-11)",
    profile: base({ days_per_week: 3 }),
    priorLogs: topRepsLog("barbell_squat", 60, { pain: true }),
    weekNumber: 2,
  },
  {
    id: "week2-progression-missed",
    why: "feedback loop: missed reps → decrease (S-GEN-11)",
    profile: base({ days_per_week: 3 }),
    priorLogs: topRepsLog("barbell_squat", 60, { failed: true }),
    weekNumber: 2,
  },
];

// ── 평가 하네스(실행 그래프 N3 · 백로그 운동목록_및_운동플랜_개선/09 §5 1) ──────────────

export interface EvalProfile extends GoldenProfile {
  /** 「좋은 플랜」 조건 — 심판 프롬프트에 그대로 들어간다(기준표 10 이 정의). */
  goodPlan: string[];
}

/** 직전 주 여러 종목을 렙 범위 안에서 수행한 기록(4주차 사용자). */
function weekLog(entries: Array<[exerciseId: string, kg: number, reps: number]>) {
  return [
    {
      schema_version: "1.0",
      session_id: "eval-s1",
      plan_id: "eval-w3",
      date: "2026-08-10",
      day_index: 0,
      completion: "completed",
      exercises: entries.map(([exerciseId, kg, reps]) => ({
        exercise_id: exerciseId,
        modality: kg === 0 ? "bodyweight" : "strength",
        sets: [1, 2, 3].map((n) => ({ set_number: n, set_kind: "working", actual_reps: reps, actual_load_kg: kg })),
      })),
    },
  ];
}

const GOOD_PLAN_BY_ID: Record<string, string[]> = {
  "beginner-2day-fullgym": ["두 날 모두 전신 — 근육마다 주 2회", "머신·덤벨 기본 운동 위주"],
  "beginner-3day-cardio-none": ["유산소 0", "주 3일 전신 또는 근육당 주 2회"],
  "beginner-4day-upperlower": ["감량 목표라 유산소가 들어간다", "상하체 분할에서 하체가 주 2회"],
  "novice-5day-ppl-conditioning": ["밀기·당기기 세트가 비슷하다", "고강도 유산소가 무거운 하체 날과 겹치지 않는다"],
  "beginner-6day-ppl": ["같은 근육 연속 이틀 없음", "주간 세트가 상한 안"],
  "beginner-bodyweight-only": ["철봉·딥바·벤치 운동 0", "푸시업·스쿼트·런지·브릿지·플랭크 같은 기본 맨몸 운동", "당기기는 로우로"],
  "beginner-home-gym-dumbbells": ["덤벨·밴드로 가능한 운동만", "덤벨 기본 운동(고블릿 스쿼트·덤벨 로우·덤벨 프레스)"],
  "beginner-minimal-shoulder-injury": ["어깨를 쓰는 운동 없음", "하체·코어는 정상 볼륨"],
  "beginner-lowrisk-flag": ["무리한 고강도·최대 근력 렙 없음"],
  "week2-progression-increase": ["바벨 스쿼트를 유지한다(연속성)"],
  "week2-progression-pain": ["통증 기록 운동을 바꾸거나 낮춘다"],
  "week2-progression-missed": ["미달 운동을 유지하고 낮춘다"],
};

export const EVAL_PROFILES: EvalProfile[] = [
  ...GOLDEN_PROFILES.map((p) => ({ ...p, goodPlan: GOOD_PLAN_BY_ID[p.id] ?? [] })),
  {
    id: "beginner-bodyweight-lose-fat",
    why: "맨몸 감량 — 맨몸 사용자의 실제 다수 목표(01 §1)",
    profile: base({ goals: ["lose_fat"], environment: "bodyweight_only", equipment: [], cardio_pref: "fat_loss" }),
    goodPlan: ["철봉·딥바·벤치 운동 0", "다관절 맨몸 운동 위주", "유산소 자리에 걷기·서킷처럼 맨몸으로 가능한 것"],
  },
  {
    id: "beginner-bodyweight-pullup-bar",
    why: "맨몸 + 철봉 있음 — 철봉 운동이 허용되는 쪽(03 §4.2)",
    profile: base({ environment: "bodyweight_only", equipment: ["pull_up_bar"] }),
    goodPlan: ["풀업·친업 같은 수직 당기기가 들어간다", "벤치·딥바 운동 0"],
  },
  {
    id: "beginner-glute-focus",
    why: "하체(둔근) 중점 — 국내 여성 사용자가 가장 많이 찾는 부위(01 §2.3)",
    profile: base({ goals: ["build_muscle", "lose_fat"], focus_area: "lower" }),
    goodPlan: ["둔근 주 세트가 0 이 아니다", "하체 운동이 상체보다 많다", "힙 쓰러스트·브릿지·런지류"],
  },
  {
    id: "week4-logged-fullgym",
    why: "기록이 있는 4주차 — 연속성과 진행(09 §5 1)",
    profile: base({ goals: ["build_muscle"] }),
    priorLogs: weekLog([
      ["leg_press", 60, 12],
      ["wide_grip_lat_pulldown", 35, 12],
      ["leverage_chest_press", 30, 12],
      ["seated_cable_rows", 30, 10],
    ]),
    weekNumber: 4,
    goodPlan: ["지난주 기본 운동 4개를 대부분 유지한다", "보조 운동은 바꿔도 된다"],
  },
];
