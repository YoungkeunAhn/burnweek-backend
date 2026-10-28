/**
 * Request/response contract for POST /v1/plans:generate
 * (docs/specs/features/001-weekly-plan-generation/contracts/generation-api.md).
 * The server never accepts numeric hints — code owns all numbers (INV-1).
 */

import type { SplitPref } from "../data/splits";

export type RedFlagHard =
  | "pregnancy"
  | "cardiac_condition"
  | "recent_surgery"
  | "acute_injury"
  | "chest_pain_on_exertion";

export type RedFlagLowRisk = "mild_joint_discomfort" | "managed_hypertension" | "general_soreness";

/**
 * 온보딩 목표. 6개이고 **다중 선택(1–3개)** 이다 — 하나만 고르게 하면 "근육도
 * 키우고 살도 빼고 싶다"가 표현되지 않는다.
 *
 * 6개인 이유: 각각이 엔진의 **서로 다른 레버**에 붙는다. 프롬프트 문구만 바뀌고
 * 처방이 같아지는 목표(자세교정·스트레스 해소 등)는 가짜 선택지라 넣지 않았다.
 *   build_muscle/gain_strength → rep_intent + 증량 허용(`loading.allowsLoadIncrease`)
 *   lose_fat/endurance         → 유산소 비중·rep_intent
 *   mobility                   → 가동성 종목 포함
 *   general_fitness            → 전신 균형, 증량 없음
 *
 * `general_fitness` 는 이름을 바꾸지 않았다 — 동결된 Flutter 앱(D16)이 계속
 * 보내는 값이라, 라벨만 "건강 유지"로 바뀌고 wire 값은 그대로다.
 */
export type Goal =
  | "build_muscle"
  | "gain_strength"
  | "lose_fat"
  | "endurance"
  | "mobility"
  | "general_fitness";

export type FocusArea = "lower" | "upper" | "balanced";

export interface UserProfile {
  /** 1–3개. 동결 클라이언트가 보내는 단수 `goal` 은 검증기가 여기로 접어 넣는다. */
  goals: Goal[];
  /**
   * 사용자가 고른 분할(2~5분할) — 헬스장 환경에서만 묻는다(D24). **선택 필드다**:
   * 없으면 종전대로 일수로 자동 선택되므로 동결 Flutter 앱(D16)과 홈짐·맨몸
   * 경로의 동작이 그대로다. 값이 있으면 요일별 부위 규칙까지 강제된다.
   */
  split_pref?: SplitPref;
  experience_level: "beginner" | "novice_intermediate";
  days_per_week: number; // 2–6
  /**
   * 사용자가 운동할 수 있는 요일(0=월 … 6=일, 오름차순 · 중복 없음 · 개수 ≥ `days_per_week`) — D46.
   * **선택 필드다**: 없으면 7일 전부로 보고 같은 코드로 벌린다(D56 ②). 근력 요일은 LLM 이 아니라
   * `pickTrainingDays` 가 이 집합 안에서 정한다.
   */
  available_days?: number[];
  // 성별은 **서버에 오지 않는다**(2026-09-15 사용자 결정 — D55 ③ 철회). 기기에만 있고(`burnweek.bodyweight.v1`),
  // 중점 부위 기본값을 클라이언트가 채우는 데만 쓴다. 서버의 덤벨 시작값은 낮은 쪽 하나다.
  /**
   * 중점 부위 — **선택 필드**(D55 ④). 온보딩 칩(하체/상체/균형)이고 기본값만 성별로 채운다.
   * 코드는 세트 배분(`allocateVolume` — 중점 쪽 상한, 반대쪽 MEV)에, LLM 은 종목 수(+1)에 쓴다.
   * 분할표·주간 상한은 그대로다. 없으면 `balanced` 와 같다(동결 Flutter 앱 · 옛 프로필).
   */
  focus_area?: FocusArea;
  session_len_min: 30 | 45 | 60 | 75 | 90;
  environment: "full_gym" | "home_gym" | "minimal" | "bodyweight_only";
  equipment: string[];
  cardio_pref: "none" | "maintain_health" | "fat_loss" | "conditioning";
  cardio_modalities: string[];
  injuries: { region: string; note?: string }[];
  red_flags: { hard: RedFlagHard[]; low_risk: RedFlagLowRisk[] };
}

export interface GenerateRequest {
  /**
   * The caller's Firebase Auth uid. The HTTP layer fills this in from the verified
   * ID token — a body-supplied value is ignored, so it can never be spoofed (T5.5).
   */
  user_id: string;
  week_start_date: string; // YYYY-MM-DD
  /**
   * Which week of the user's programme this is (≥1). The app owns the count — the
   * backend keeps no user history (NFR-PRIV-1), so it cannot derive it. Absent
   * means week 1.
   */
  week_number?: number;
  /**
   * FCM device token for the completion push (ADR-0011). **Optional.**
   * 토스 미니앱은 FCM 을 쓸 수 없다(토스가 알림을 소유한다) — 토큰이 없으면
   * 푸시를 건너뛰고 클라이언트 폴링이 유일 경로가 된다. Flutter 앱(D16 동결)은
   * 계속 토큰을 보내므로 푸시 경로는 지우지 않고 남긴다.
   */
  fcm_token?: string;
  /**
   * 완료 시 **앱인토스 기능성 푸시**를 보낼지(2026-09-08). 앱이 알림 동의(`Notification.requestAgreement`)를 받은 뒤 `true` 로 보낸다.
   * 동의 없이 보내면 토스가 거절할 뿐이라 서버는 값을 믿고 시도만 한다. 토스 로그인 신원(`toss:`)에만 의미가 있다.
   */
  toss_push?: boolean;
  profile: UserProfile;
  /** PerformedSession v1[] — [] on week 1 / no history (S-GEN-7). */
  prior_logs: unknown[];
  /**
   * 직전 주에 실제로 편성됐던 종목 id. **연속성 신호**다 — 매주 처음부터 짜면
   * 같은 프로필에도 매번 다른 종목이 나와서 "계속 비슷한 운동으로 나아간다"가
   * 성립하지 않는다.
   *
   * 수행 로그가 아니라 **직전 주 플랜의 프록시**다: 미니앱에 수행 기록 화면이
   * 아직 없어 `prior_logs` 가 항상 비어 있기 때문이다. 로깅이 붙으면
   * `prior_logs` 가 더 정확한 원천이 되고 이 필드는 그 폴백으로 남는다.
   * id 뿐이라 수치는 넘어가지 않는다(INV-1).
   */
  recent_exercise_ids?: string[];
  /**
   * 이번 주에 이미 완료한 세션의 요일과 근력 종목 id(D60 ②). **서버 산출** — 접수가 같은 주 문서의
   * `sessions`(§2.4)에서 만든다. 수치는 없다(INV-1). 재생성에서 분할 순서를 완료한 날 뒤로 이어가고
   * 프롬프트 `<completed_this_week>` 에 실린다. 없으면 빈 배열 = 종전과 같다.
   */
  completed_this_week?: CompletedDay[];
  /**
   * 서킷 화면이 있는 클라이언트라는 표시(N10d · 사용자 2026-10-16 「새 앱만 서킷」). **보내는 쪽만 서킷을 받는다** —
   * 서킷 화면이 없는 옛 번들은 이 필드를 모르므로 맨몸 감량이어도 종전 유산소를 받는다(N7a↔N7b 짝).
   */
  supports_circuits?: boolean;
}

/** 완료한 하루 — 요일과 카탈로그에 있는 근력 종목 id 만(D60 ②). */
export interface CompletedDay {
  day_index: number;
  exercise_ids: string[];
}

/**
 * Result of the generation PIPELINE (gate→draft→expand→validate). In async mode
 * this is the worker's internal outcome; `blocked_red_flag` is decided
 * synchronously at intake and never reaches the worker (ADR-0011).
 */
export interface GenerateResponse {
  status: "ok" | "blocked_red_flag" | "error";
  plan?: unknown; // WeeklyPlan v1
  /**
   * 플랜을 만든 DraftPlan v1(수치 없음). 사용자가 나중에 종목을 빼거나 바꿀 때
   * **이걸 고쳐 다시 확장한다**(백로그 016, `generation/edit.ts`) — 플랜에는
   * rep_intent·role 이 남지 않아 플랜만으로는 같은 확장을 재현할 수 없다.
   */
  draft?: unknown;
  warnings?: string[];
  message?: string;
  /**
   * 관측용 계측(백로그 009). 사용자 데이터가 아니라 수치·모델명뿐이며 Firestore
   * 잡에는 쓰지 않는다 — 호출 층이 로그로만 흘린다. LLM 어댑터가 usage 를
   * 잡아 두고도 소비처가 없던 것을 여기서 잇는다.
   */
  telemetry?: {
    model?: string;
    llmCalls: number;
    totalTokens?: number;
    llmLatencyMs: number;
  };
}

/**
 * GenerationJob — ephemeral async job record (Firestore, short TTL; ADR-0011,
 * 02-data-model §GenerationJob). `blocked_red_flag` is NOT a job state.
 */
export type JobStatus = "queued" | "running" | "ok" | "error";

export interface GenerationJob {
  job_id: string;
  user_id: string;
  status: JobStatus;
  created_at: string; // date-time
  /** TTL 필드. **`Date`(→ Firestore Timestamp)여야 한다** — 문자열이면 정책이 못 읽는다. */
  expires_at: Date;
  fcm_token?: string; // 없으면 완료 푸시를 보내지 않는다(폴링 전용 클라이언트)
  account_version?: string; // 토스 연결 버전. 삭제 뒤 늦은 워커의 저장을 거부한다.
  generation_reserved?: boolean; // ADR-0013: 성공 시 확정, 실패 시 무료/광고 사용 기회 복구
  toss_push?: boolean; // 앱인토스 기능성 푸시(2026-09-08) — 동의한 사용자만 true 로 보낸다
  plan?: unknown; // WeeklyPlan v1 — only when status='ok'
  warnings?: string[];
  message?: string; // error reason
}
