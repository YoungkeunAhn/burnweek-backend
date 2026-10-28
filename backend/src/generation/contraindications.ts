/**
 * Injury contraindications — exclusion and substitution (S-GEN-4, FR-GEN-4).
 *
 * Code owns this: the LLM is told to avoid injured regions and we do not trust it
 * to. An exercise loading a contraindicated muscle is removed and, where a clean
 * replacement exists, swapped; either way it lands in
 * `safety.excluded_exercise_ids`.
 *
 * The onboarding *injury region* option list is still open (PRD §13 / gate G1), so
 * this maps regions mechanically onto structures the catalogue already names — the
 * 17-value muscle taxonomy and the volume cap groups — and **reports** anything it
 * cannot map instead of silently ignoring it. No joint model is invented here.
 */
import { CAP_GROUPS } from "../data/constants";
import { capGroupOf, find, profileFilter, type Exercise } from "../data/exercises";
import type { DraftStrengthItem } from "./expand";
import type { UserProfile } from "./types";

/** free-exercise-db's flat 17-value muscle taxonomy (02-data-model §ExerciseTemplate). */
const MUSCLE_TAXONOMY = [
  "abdominals",
  "abductors",
  "adductors",
  "biceps",
  "calves",
  "chest",
  "forearms",
  "glutes",
  "hamstrings",
  "lats",
  "lower back",
  "middle back",
  "neck",
  "quadriceps",
  "shoulders",
  "traps",
  "triceps",
] as const;

const KNOWN_MUSCLES = new Set<string>(MUSCLE_TAXONOMY);

/** Every catalogue muscle that rolls up to the given cap group. */
function musclesOfCapGroup(group: string): string[] {
  return MUSCLE_TAXONOMY.filter((muscle) => capGroupOf(muscle) === group);
}

export interface ContraindicationSet {
  /** Catalogue muscles that must not be loaded. */
  muscles: string[];
  /** Injury regions the catalogue has no name for — reported, not guessed. */
  unmappedRegions: string[];
  /** Low-risk flags that carry no region, so nothing can be excluded (FR-SAFE-4). */
  warnings: string[];
}

/**
 * Turns the profile's injuries into a muscle exclusion set.
 * A region matches either a catalogue muscle (`shoulders`) or a cap group
 * (`back` → lats/middle back/lower back/traps).
 */
export function contraindicatedMuscles(profile: UserProfile): ContraindicationSet {
  const muscles = new Set<string>();
  const unmappedRegions: string[] = [];

  for (const injury of profile.injuries ?? []) {
    const region = String(injury.region ?? "").trim().toLowerCase();
    if (!region) continue;
    if (KNOWN_MUSCLES.has(region)) {
      muscles.add(region);
      continue;
    }
    if ((CAP_GROUPS as string[]).includes(region)) {
      for (const muscle of musclesOfCapGroup(region)) muscles.add(muscle);
      continue;
    }
    unmappedRegions.push(region);
  }

  const warnings: string[] = [];
  for (const flag of profile.red_flags?.low_risk ?? []) {
    warnings.push(
      `저위험 주의(${flag})가 기록되어 있습니다. 통증이 있는 동작은 중단하고 범위를 줄이세요.`,
    );
  }
  if (unmappedRegions.length > 0) {
    warnings.push(
      `부상 부위 "${unmappedRegions.join(", ")}"는 운동 카탈로그의 부위명과 매칭되지 않아 자동 제외에 반영하지 못했습니다.`,
    );
  }

  return { muscles: [...muscles].sort(), unmappedRegions, warnings };
}

export interface FilterResult {
  /**
   * The surviving plan, **substitutions already applied**. Returned as items
   * rather than indices so a caller cannot accidentally read the contraindicated
   * original back out of the input array.
   */
  kept: DraftStrengthItem[];
  /** Contract field `safety.excluded_exercise_ids` — originals removed. */
  excludedExerciseIds: string[];
  notes: string[];
}

/**
 * Removes contraindicated exercises and substitutes where a clean option exists.
 *
 * A substitute must train at least one of the original's non-excluded primary
 * muscles, use equipment the user has, load nothing contraindicated, and not
 * already be in the plan. When nothing qualifies the slot is simply dropped — an
 * empty slot is safe, a contraindicated lift is not.
 */
export function excludeContraindicated(
  strength: DraftStrengthItem[],
  profile: UserProfile,
  contraindicated: ContraindicationSet,
  allowedGeneratedExerciseIds?: readonly string[],
): FilterResult {
  const excluded = new Set(contraindicated.muscles);
  const kept: DraftStrengthItem[] = [];
  const excludedExerciseIds: string[] = [];
  const notes: string[] = [];

  if (excluded.size === 0) return { kept: [...strength], excludedExerciseIds, notes };

  const inPlan = new Set(strength.map((item) => item.exercise.id));

  for (const item of strength) {
    const conflicts = item.exercise.contraindication_tags.filter((muscle) => excluded.has(muscle));
    if (conflicts.length === 0) {
      kept.push(item);
      continue;
    }

    excludedExerciseIds.push(item.exercise.id);

    const replacement = findReplacement(item, profile, excluded, inPlan, allowedGeneratedExerciseIds);
    if (replacement) {
      inPlan.add(replacement.id);
      kept.push({ ...item, exercise: replacement });
      const mechanicChanged =
        item.exercise.mechanic !== null && replacement.mechanic !== item.exercise.mechanic;
      notes.push(
        `${item.exercise.name_ko}은(는) 부상 부위(${conflicts.join(", ")})를 사용해 ${replacement.name_ko}로 대체했습니다.` +
          (mechanicChanged ? " (복합↔고립 유형이 바뀌었습니다)" : ""),
      );
    } else {
      notes.push(
        `${item.exercise.name_ko}은(는) 부상 부위(${conflicts.join(", ")})를 사용해 제외했습니다. 대체 후보가 없습니다.`,
      );
    }
  }

  return { kept, excludedExerciseIds, notes };
}

/**
 * A replacement must train one of the original's surviving primary muscles, load
 * nothing contraindicated, use equipment the user has, and not already be in the
 * plan. **Same mechanic first**: swapping a compound for an isolation lift changes
 * what the slot means for volume and load. A different mechanic is still allowed
 * as a fallback — an isolation lift that trains the muscle beats an empty slot —
 * but the swap is called out in the notes so the user sees it.
 */
function findReplacement(
  item: DraftStrengthItem,
  profile: UserProfile,
  excluded: Set<string>,
  inPlan: Set<string>,
  allowedGeneratedExerciseIds?: readonly string[],
): Exercise | undefined {
  const wantedMuscles = item.exercise.primary_muscles.filter((muscle) => !excluded.has(muscle));
  if (wantedMuscles.length === 0) return undefined;

  const allowedIds =
    allowedGeneratedExerciseIds === undefined ? undefined : new Set(allowedGeneratedExerciseIds);
  const base = {
    modality: item.exercise.modality,
    primaryMuscles: wantedMuscles,
    ...profileFilter(profile),
    excludeMuscles: [...excluded],
  };
  const pick = (candidates: Exercise[]) =>
    candidates
      .filter((candidate) => !inPlan.has(candidate.id) && (allowedIds === undefined || allowedIds.has(candidate.id)))
      .sort((a, b) => a.id.localeCompare(b.id))[0];

  const sameMechanic = item.exercise.mechanic
    ? pick(find({ ...base, mechanic: item.exercise.mechanic }))
    : undefined;
  return sameMechanic ?? pick(find(base));
}
