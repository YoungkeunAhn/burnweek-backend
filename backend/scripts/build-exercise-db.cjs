#!/usr/bin/env node
/**
 * Regenerates `src/data/exercises.json` from yuhonas/free-exercise-db (public
 * domain / Unlicense). Run only when the upstream catalogue should be refreshed:
 *
 *   node scripts/build-exercise-db.cjs
 *   node scripts/build-exercise-db.cjs --refresh-labels  (offline, labels only)
 *
 * The vendored output is committed so generation is deterministic and needs no
 * network at runtime. It keeps only the fields the expansion engine uses —
 * `instructions` and `images` are dropped (~1.0MB → ~0.2MB).
 *
 * `name_ko` is composed from `scripts/name-ko-glossary.cjs` (D13: all 873 named
 * in Korean). An unknown token aborts the build rather than shipping English.
 * Curated whole-name corrections in `src/data/exercise-labels.json` take precedence.
 *
 * Canonical ids: upstream ids are TitleCase with hyphens (`3_4_Sit-Up`). We
 * lowercase and slugify them so one form is used everywhere (plans, logs,
 * prompts) and so a model-invented id like `barbell_back_squat` can match.
 *
 * **커스텀 종목**(upstream 에 없는 기구 — D57 A15 마이마운틴)은 `scripts/custom-exercises.json`
 * 에 두고 여기서 병합한다(`is_custom: true`). json 에 손으로 넣으면 다음 빌드에 사라진다.
 * 이름은 사전 조합이 아니라 원천의 `name_ko` 를 그대로 쓰고, 동작 사진은 없다.
 *
 * **upstream 태그 정정**(`requires` · `other`→`body only` · `stretching` 오분류)은
 * `scripts/catalog-overrides.json` 에 두고 `applyOverrides` 가 건다(백로그 운동목록 02 §2 · 04 §4).
 * `"body only"` 는 외부 하중이 없다는 뜻이지 도구가 없다는 뜻이 아니라서 `requires` 가 따로 있다.
 */
const fs = require("node:fs");
const path = require("node:path");
const { nameKo, untranslated } = require("./name-ko.cjs");

const SOURCE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json";
const OUT = path.join(__dirname, "..", "src", "data", "exercises.json");
const CUSTOM = path.join(__dirname, "custom-exercises.json");
const OVERRIDES = path.join(__dirname, "catalog-overrides.json");

/** 백로그 02 §3 1 의 도구 enum. 밖의 값이면 멈춘다. */
const TOOLS = ["pull_up_bar", "dip_bars", "bench", "sturdy_chair", "box_or_step", "partner", "wall", "dumbbell", "exercise_ball"];

/**
 * upstream 태그를 고친다. **없는 id 를 가리키면 멈춘다** — upstream 이 id 를 바꾸면 정정이
 * 조용히 빠진다. 옛 값은 `retagged_from` 에 남긴다(헬스장 후보는 옛 값으로 본다 — exercises.ts). 장비·분류를 바꾸면 그것에서 파생된 `modality`·`default_metric` 도 다시 낸다.
 * 이미 고친 목록에 다시 걸어도 같다(커밋된 json 대조 테스트가 기댄다).
 */
function applyOverrides(list, overrides) {
  const byId = new Map(list.map((e) => [e.id, e]));
  const out = new Map(list.map((e) => [e.id, { ...e }]));
  for (const [id, patch] of Object.entries(overrides.retag)) {
    if (!byId.has(id)) throw new Error(`override id not in catalogue: ${id}`);
    const e = out.get(id);
    // 다시 걸어도 같다 — 옛 값은 처음 고칠 때의 것만 남긴다.
    const retagged_from = e.retagged_from ?? { equipment: e.equipment, category: e.category };
    Object.assign(e, patch, { retagged_from });
    Object.assign(e, { modality: modality(e), default_metric: defaultMetric(e) });
  }
  for (const [id, tools] of Object.entries(overrides.requires)) {
    if (!byId.has(id)) throw new Error(`override id not in catalogue: ${id}`);
    const bad = tools.filter((t) => !TOOLS.includes(t));
    if (bad.length > 0) throw new Error(`unknown tool for ${id}: ${bad.join(", ")}`);
    out.get(id).requires = tools;
  }
  return list.map((e) => out.get(e.id));
}

/**
 * upstream 결과에 커스텀 원천을 붙인다. **id 가 겹치면 멈춘다** — 덮어쓰면 upstream 종목이
 * 조용히 바뀐다. `source` 는 원천의 증빙이라 카탈로그에 싣지 않는다.
 */
function mergeCustom(upstream, custom) {
  const ids = new Set(upstream.map((e) => e.id));
  const added = custom.map(({ source: _source, ...e }) => {
    if (ids.has(e.id)) throw new Error(`custom id collides with upstream: ${e.id}`);
    const bad = (e.requires ?? []).filter((t) => !TOOLS.includes(t));
    if (bad.length > 0) throw new Error(`unknown tool for ${e.id}: ${bad.join(", ")}`);
    ids.add(e.id);
    return { ...e, contraindication_tags: [...new Set([...e.primary_muscles, ...e.secondary_muscles])], is_custom: true };
  });
  return [...upstream, ...added].sort((a, b) => a.id.localeCompare(b.id));
}

/** `3_4_Sit-Up` → `3_4_sit_up`. Must satisfy /^[a-z0-9_]{1,64}$/. */
function canonicalId(id) {
  return id
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/** ExerciseTemplate.modality (02-data-model §ExerciseTemplate). */
function modality(e) {
  if (e.category === "cardio") return "cardio";
  return e.equipment === "body only" ? "bodyweight" : "strength";
}

/** ExerciseTemplate.default_metric — cardio is timed, everything else is reps. */
function defaultMetric(e) {
  return e.category === "cardio" ? "duration" : "reps";
}

async function main() {
  // Refresh labels without fetching a moving upstream catalogue or changing IDs/tags.
  if (process.argv.includes("--refresh-labels")) {
    const list = JSON.parse(fs.readFileSync(OUT, "utf8"));
    const refreshed = list.map((e) => e.is_custom ? e : { ...e, name_ko: nameKo(e.name) });
    fs.writeFileSync(OUT, `${JSON.stringify(refreshed)}\n`, "utf8");
    console.log(`${refreshed.length} exercise labels refreshed`);
    return;
  }
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const upstream = await res.json();

  const seen = new Map();
  const out = upstream
    .map((e) => {
      const id = canonicalId(e.id);
      if (seen.has(id)) throw new Error(`canonical id collision: ${id} (${e.id} vs ${seen.get(id)})`);
      seen.set(id, e.id);
      const missing = untranslated(e.name);
      if (missing.length > 0) {
        throw new Error(`name_ko 사전 누락: ${e.name} → ${missing.join(", ")} (scripts/name-ko-glossary.cjs에 추가)`);
      }
      const primary = e.primaryMuscles ?? [];
      const secondary = e.secondaryMuscles ?? [];
      return {
        id,
        name: e.name,
        // 한글 이름은 사전 기반 조합(D13). 미번역 토큰이 남으면 즉시 실패한다 —
        // 영어가 UI로 새어나가는 것보다 빌드가 멈추는 게 낫다.
        name_ko: nameKo(e.name),
        modality: modality(e),
        default_metric: defaultMetric(e),
        equipment: e.equipment ?? "other",
        category: e.category,
        mechanic: e.mechanic ?? null,
        force: e.force ?? null,
        level: e.level,
        primary_muscles: primary,
        secondary_muscles: secondary,
        // Every muscle the exercise loads. Injury exclusion (node B4) intersects
        // this with the user's contraindicated muscles.
        contraindication_tags: [...new Set([...primary, ...secondary])],
        is_custom: false,
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const overridden = applyOverrides(out, JSON.parse(fs.readFileSync(OVERRIDES, "utf8")));
  const catalogue = mergeCustom(overridden, JSON.parse(fs.readFileSync(CUSTOM, "utf8")));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, `${JSON.stringify(catalogue, null, 0)}\n`, "utf8");
  console.log(`${catalogue.length} exercises → ${OUT} (${fs.statSync(OUT).size} bytes)`);
}

module.exports = { mergeCustom, applyOverrides, TOOLS, CUSTOM, OVERRIDES, OUT };

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
