/**
 * 맨몸 서킷 템플릿([D102] ① ④ · 백로그 운동목록 11). 동작 목록과 순서는 인기 영상에서 참고했고, 이름은 중립
 * 이름 · 출처는 링크로만 밝힌다(D102 ③ — 유튜버·채널 이름을 쓰지 않는다). 초·렙·라운드는 코드 상수다(INV-1).
 *
 * 형식: A = 시간 기반 연속(동작마다 초) · B = 횟수 라운드(라운드마다 렙) · C = 운동별 세트(같은 동작을 세트로).
 * 입문 버전(D102 ④ · 11 §4): 점프 동작을 대체 동작으로 바꾸고, 라운드·렙은 아래 축소 규칙으로 줄인다.
 */

export type CircuitFormat = "A" | "B" | "C";

export interface CircuitTemplate {
  id: string;
  /** 중립 이름(채널명 금지 — T7-4). */
  name: string;
  format: CircuitFormat;
  /** 참고 영상 — 앱 핵심 흐름은 이 링크에 의존하지 않는다(토스 외부 링크 정책 · 06 §6). */
  source_url: string;
  /** 입문 버전이 기본 대상인가(중급 이상만이면 false — 그래도 입문 버전은 있다). */
  beginnerFirst: boolean;
  /** 동작 순서. A 는 `seconds`, B·C 는 라운드(세트)별 렙 `reps[]`. */
  moves: Array<{ id: string; seconds?: number; reps?: number[] }>;
  /** A·B 라운드 수(입문 · 기본). C 는 `reps` 길이가 세트 수다. */
  rounds?: { beginner: number; standard: number };
  /** 동작(또는 세트) 사이 휴식 초. */
  restSeconds: number;
}

/** 입문 대체(11 §4) — 점프·고충격 → 저충격. 키는 원본, 값은 대체. */
export const BEGINNER_SWAP: Record<string, string> = {
  burpee: "slow_burpee",
  jumping_jacks: "step_jack",
  high_knees: "marching_in_place",
  skater: "side_step",
  freehand_jump_squat: "bodyweight_squat",
  small_jump_arm_fold: "tap_step_arm_raise",
  pushups: "knee_push_up",
};

/** 점프가 있는 동작 — 입문 버전에 0개여야 한다(T7-2b). */
export const JUMP_MOVES = new Set(["burpee", "jumping_jacks", "high_knees", "skater", "freehand_jump_squat", "small_jump_arm_fold"]);

const range = (n: number, reps: number) => Array.from({ length: n }, () => reps);

export const CIRCUIT_TEMPLATES: CircuitTemplate[] = [
  {
    id: "A1",
    name: "7분 전신 서킷",
    format: "A",
    source_url: "https://www.youtube.com/watch?v=Jru5B044HOs",
    beginnerFirst: true,
    moves: [
      "jumping_jacks", "wall_sit", "pushups", "crunches", "step_up_with_knee_raise", "bodyweight_squat",
      "bench_dips", "plank", "high_knees", "bodyweight_lunge", "push_up_to_side_plank", "side_bridge",
    ].map((id) => ({ id, seconds: 30 })),
    rounds: { beginner: 1, standard: 2 },
    restSeconds: 10,
  },
  {
    id: "A2",
    name: "서서 하는 저충격 전신 서킷",
    format: "A",
    source_url: "https://www.youtube.com/watch?v=lKwZ2DU4P-A",
    beginnerFirst: true,
    moves: [
      "tap_step_arm_raise", "squat_twist", "standing_cross_toe_touch", "wide_squat", "inchworm", "step_jack",
      "bodyweight_good_morning", "slow_burpee", "standing_knee_up", "bodyweight_squat", "small_jump_arm_fold",
      "standing_side_crunch", "reverse_lunge_knee_up", "skater",
    ].map((id) => ({ id, seconds: 40 })),
    rounds: { beginner: 1, standard: 2 },
    restSeconds: 10,
  },
  {
    id: "B1",
    name: "피라미드 버피·스쿼트·싯업",
    format: "B",
    source_url: "https://www.youtube.com/watch?v=B_mOva3qtSE",
    beginnerFirst: false,
    moves: ["burpee", "bodyweight_squat", "sit_up"].map((id) => ({ id, reps: [50, 40, 30, 20, 10] })),
    restSeconds: 0,
  },
  {
    id: "C1",
    name: "슬로우 버피 100",
    format: "C",
    source_url: "https://www.youtube.com/watch?v=Uly8jUuscOw",
    beginnerFirst: true,
    moves: [{ id: "slow_burpee", reps: range(5, 20) }],
    restSeconds: 10,
  },
  {
    id: "C2",
    name: "하체 스쿼트 100",
    format: "C",
    source_url: "https://www.youtube.com/watch?v=FsqhUFcjL8k",
    beginnerFirst: true,
    moves: ["bodyweight_squat", "narrow_squat", "wide_squat", "pulse_squat"].map((id) => ({ id, reps: [25] })),
    restSeconds: 10,
  },
];

export interface CircuitMove {
  exercise_id: string;
  /** A: 라운드마다 초 · B·C: 세트(라운드)마다 렙. */
  sets: Array<{ seconds: number } | { reps: number }>;
  rest_seconds: number;
}

/**
 * 템플릿 → 동작별 세트. 입문이면 대체 동작 · A 라운드는 입문 값 · B·C 렙은 절반(올림)이다.
 * ponytail: 축소는 일률 절반 — 실기기 피드백(U3)으로 템플릿별 값을 다시 정한다.
 */
export function expandCircuit(template: CircuitTemplate, beginner: boolean): CircuitMove[] {
  const swap = (id: string) => (beginner ? (BEGINNER_SWAP[id] ?? id) : id);
  const rounds = template.rounds ? (beginner ? template.rounds.beginner : template.rounds.standard) : 1;
  // 입문 대체가 이미 있는 동작과 겹치면(A2: 작은 점프 → 탭 스텝) 처음 것만 남긴다 — 한 서킷에 같은 동작 두 줄은
  // 기록이 종목 id 로 묶여 섞인다.
  const seen = new Set<string>();
  const unique = template.moves.filter((move) => {
    const id = swap(move.id);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return unique.map((move) => ({
    exercise_id: swap(move.id),
    sets:
      move.seconds !== undefined
        ? Array.from({ length: rounds }, () => ({ seconds: move.seconds! }))
        : (move.reps ?? []).map((reps) => ({ reps: beginner ? Math.ceil(reps / 2) : reps })),
    rest_seconds: template.restSeconds,
  }));
}

/** 대략 분 — 주간 소요 표시용(A 는 초 + 전환, B·C 는 렙당 3초 근사). */
export function circuitMinutes(moves: CircuitMove[]): number {
  const sec = moves.reduce(
    (sum, m) => sum + m.sets.reduce((s, set) => s + ("seconds" in set ? set.seconds : set.reps * 3) + m.rest_seconds, 0),
    0,
  );
  return Math.max(1, Math.round(sec / 60));
}

/**
 * 이번 주 n번째 서킷 세션의 템플릿. 추천 형식(`recommendCardio` — 입문 A, 중급 이상 A·B)에 C(운동별 세트)를
 * 더해 돌린다 — C 는 지금 세트 구조 그대로라 입문에도 맞다(D102 ① · 11 §1 대상 「입문」).
 */
export function circuitTemplateFor(formats: Array<"A" | "B">, nth: number): CircuitTemplate {
  // 형식마다 줄을 세우고 A → C → B 로 한 칸씩 번갈아 — 입문: A1·C1·A2·C2, 중급 이상: A1·C1·B1·A2·C2.
  const queues = (["A", "C", "B"] as const).map((f) =>
    CIRCUIT_TEMPLATES.filter((t) => t.format === f && (f === "C" || (formats as string[]).includes(f))),
  );
  const order: CircuitTemplate[] = [];
  for (let i = 0; queues.some((q) => q[i]); i += 1) for (const q of queues) if (q[i]) order.push(q[i]!);
  return order[nth % order.length]!;
}
