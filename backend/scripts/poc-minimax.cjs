/**
 * MiniMax structured-output POC diagnostic. Calls the provider ONCE (no retry
 * loop) and dumps the raw model output + ajv validation errors so we can see
 * exactly why/whether the DraftPlan validates. Read-only wrt state; live API.
 */
const fs = require("fs");
const path = require("path");

const envPath = path.join(__dirname, "..", ".env");
for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !line.trim().startsWith("#")) {
    const val = m[2].replace(/^["']|["']$/g, "");
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

const { buildConfig } = require("../lib/config");
const { createProvider } = require("../lib/llm");
const { buildSystemPrefix, buildUserContext } = require("../lib/generation/prompt");
const { checkDraftPlan } = require("../lib/schemas/validate");
const draftSchema = require("../lib/schemas/draft-plan.schema.json");

const profile = {
  goal: "build_muscle", experience_level: "beginner", days_per_week: 3,
  session_len_min: 60, environment: "full_gym",
  equipment: ["barbell", "dumbbell", "cable"],
  cardio_pref: "maintain_health", cardio_modalities: ["cycling"],
  injuries: [], red_flags: { hard: [], low_risk: [] },
};

async function main() {
  const config = buildConfig(process.env);
  const provider = createProvider(config.llm);
  const req = {
    systemPrefix: buildSystemPrefix(draftSchema),
    userContext: buildUserContext({ profile, prior_logs: [], week_start_date: "2026-08-17" }),
    draftSchema,
  };

  console.log(`[POC] model=${config.llm.model} base=${config.llm.baseUrl}`);
  const t = Date.now();
  const raw = await provider.generateDraft(req);
  console.log(`[POC] elapsed ${((Date.now() - t) / 1000).toFixed(1)}s, model=${raw.model}, usage=`, raw.usage);

  const draft = raw.draft;
  console.log("\n=== RAW draft type:", typeof draft, "===");
  if (typeof draft === "string") {
    console.log("--- draft is a STRING (JSON.parse failed). First 2000 chars: ---");
    console.log(draft.slice(0, 2000));
  } else {
    console.log(JSON.stringify(draft, null, 2).slice(0, 4000));
  }

  const check = checkDraftPlan(draft);
  console.log("\n=== VALIDATION:", check.ok ? "PASS ✅" : "FAIL ❌", "===");
  if (!check.ok) check.errors.slice(0, 30).forEach((e) => console.log("  -", e));
}

main().catch((e) => { console.error("POC ERROR:", e); process.exit(1); });
