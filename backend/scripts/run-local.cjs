/**
 * Local runner — exercises the runtime-agnostic handler WITHOUT Firebase/Java.
 * Proves the whole pipeline end to end: config load, red-flag gate (0 LLM calls),
 * a real MiniMax draft, code expansion, and the final WeeklyPlan v1 validation.
 *
 *   node scripts/run-local.cjs            # all cases
 *   node scripts/run-local.cjs --no-llm   # gate case only (no API cost)
 */
const fs = require("fs");
const path = require("path");

// --- minimal .env loader (no dotenv dep) ---
// `.env.local` first: it holds the API key and is never deployed, while `.env`
// holds the non-secret config that `firebase deploy` turns into env vars.
for (const name of [".env.local", ".env"]) {
  const envPath = path.join(__dirname, "..", name);
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith("#")) {
      const val = m[2].replace(/^["']|["']$/g, "");
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  }
}

const { buildConfig } = require("../lib/config");
const { generatePlan } = require("../lib/generation/handler");

const baseProfile = {
  goal: "build_muscle",
  experience_level: "beginner",
  days_per_week: 3,
  session_len_min: 60,
  environment: "full_gym",
  equipment: ["barbell", "dumbbell", "cable"],
  cardio_pref: "maintain_health",
  cardio_modalities: ["cycling"],
  injuries: [],
  red_flags: { hard: [], low_risk: [] },
};

async function main() {
  const noLlm = process.argv.includes("--no-llm");
  const config = buildConfig(process.env);
  console.log(`[config] provider=${config.llm.provider} model=${config.llm.model} baseUrl=${config.llm.baseUrl}\n`);

  // Case 1: hard red flag → blocked, ZERO LLM calls.
  console.log("=== Case 1: hard red-flag gate (no LLM call) ===");
  const blocked = await generatePlan(
    { user_id: "u1", week_start_date: "2026-08-17", profile: { ...baseProfile, red_flags: { hard: ["chest_pain_on_exertion"], low_risk: [] } }, prior_logs: [] },
    { config },
  );
  console.log(JSON.stringify(blocked, null, 2), "\n");

  if (noLlm) return;

  // Case 2: clean profile → REAL MiniMax draft call + schema validation → expand stub.
  console.log("=== Case 2: real MiniMax draft generation (live API) ===");
  const t = Date.now();
  const res = await generatePlan(
    { user_id: "u1", week_start_date: "2026-08-17", profile: baseProfile, prior_logs: [] },
    { config },
  );
  console.log(`(elapsed ${((Date.now() - t) / 1000).toFixed(1)}s)`);
  console.log(`status=${res.status}`);
  if (res.status === "ok") {
    const plan = res.plan;
    console.log(`plan_id=${plan.plan_meta.plan_id} split=${plan.plan_meta.split_type}`);
    for (const day of plan.week) {
      const items = day.exercises
        .map((e) => (e.modality === "cardio"
          ? `${e.name}(${e.cardio_detail.style} ${e.cardio_detail.duration_min}분/${e.cardio_detail.placement})`
          : `${e.name}(${e.sets.filter((s) => s.set_kind === "working").length}세트)`))
        .join(", ");
      console.log(`  day ${day.day_index} [${day.session_type}] ${day.focus} — ${items}`);
    }
    console.log("warnings:", res.warnings);
    console.log("excluded:", plan.safety.excluded_exercise_ids);
  } else {
    console.log("message:", res.message);
  }

  // Case 3: same profile with week-2 logs — proves the progression path.
  console.log("\n=== Case 3: week 2 with prior logs (live API) ===");
  const priorLogs = [
    {
      schema_version: "1.0",
      session_id: "s1",
      plan_id: "u1-w1",
      date: "2026-08-10",
      day_index: 0,
      completion: "completed",
      exercises: [
        {
          exercise_id: "barbell_squat",
          modality: "strength",
          sets: [
            { set_number: 1, set_kind: "warmup", actual_reps: 5, actual_load_kg: 30 },
            { set_number: 2, set_kind: "working", actual_reps: 12, actual_load_kg: 60 },
            { set_number: 3, set_kind: "working", actual_reps: 12, actual_load_kg: 60 },
          ],
        },
      ],
    },
  ];
  const t2 = Date.now();
  const res2 = await generatePlan(
    { user_id: "u1", week_start_date: "2026-08-24", week_number: 2, profile: baseProfile, prior_logs: priorLogs },
    { config },
  );
  console.log(`(elapsed ${((Date.now() - t2) / 1000).toFixed(1)}s) status=${res2.status}`);
  if (res2.status === "ok") {
    const squat = res2.plan.week.flatMap((d) => d.exercises).find((e) => e.exercise_id === "barbell_squat");
    console.log("squat decision:", squat ? JSON.stringify(squat.progression_decision) : "(not selected by the model)");
  } else {
    console.log("message:", res2.message);
  }
}

main().catch((e) => {
  console.error("RUNNER ERROR:", e);
  process.exit(1);
});
