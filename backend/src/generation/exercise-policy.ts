import { allowedEquipment, candidateIdsFor, equipmentFor, resolve } from "../data/exercises";
import type { UserProfile } from "./types";

/**
 * Exact catalogue ids the model may select for this generation request.
 * The prompt, resolver, and pre-save guard must compare against this same set.
 */
export function allowedGeneratedExerciseIds(
  profile: UserProfile,
  recentExerciseIds: readonly string[] = [],
): string[] {
  return candidateIdsFor(profile, undefined, recentExerciseIds);
}

/**
 * Defense-in-depth for the final AI-generated plan. Cardio is code-owned and
 * intentionally outside the strength candidate list. Manual edit expansion
 * never calls this function, preserving the explicit user-pick escape hatch.
 */
export function generatedPlanExerciseProblems(
  plan: unknown,
  profile: UserProfile,
  allowedExerciseIds: readonly string[],
): string[] {
  const allowedIds = new Set(allowedExerciseIds);
  const equipment = allowedEquipment(profile);
  const week = (plan as { week?: unknown } | null)?.week;
  if (!Array.isArray(week)) return ["generated plan has no week array"];

  const problems = new Set<string>();
  for (const day of week) {
    const exercises = (day as { exercises?: unknown } | null)?.exercises;
    if (!Array.isArray(exercises)) continue;
    for (const item of exercises) {
      const exerciseId = (item as { exercise_id?: unknown } | null)?.exercise_id;
      if (typeof exerciseId !== "string") {
        problems.add("generated plan contains an exercise without exercise_id");
        continue;
      }
      const exercise = resolve(exerciseId);
      if (!exercise) {
        problems.add(`generated exercise_id is not in the catalogue: ${exerciseId}`);
        continue;
      }
      if (exercise.modality === "cardio" || exercise.category === "cardio") continue;
      // 서킷은 코드 템플릿이다(D102) — LLM 후보 목록 밖이어도 된다.
      if ((item as { circuit?: unknown }).circuit) continue;
      if (!allowedIds.has(exercise.id) || (equipment !== undefined && !equipment.has(equipmentFor(exercise, profile)))) {
        problems.add(
          `generated exercise_id is outside available_exercise_ids/equipment: ${exerciseId} (${exercise.equipment})`,
        );
      }
    }
  }
  return [...problems];
}
