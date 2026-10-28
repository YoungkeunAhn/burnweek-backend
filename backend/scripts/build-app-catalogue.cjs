#!/usr/bin/env node
/**
 * Slims the vendored catalogue into the app asset `app/assets/exercises.json`:
 *
 *   node scripts/build-app-catalogue.cjs
 *
 * Why a second copy: the app ranks substitutes offline (S-LOG-2/S-LOG-7) and the
 * plan carries no candidate ids, so the ranking needs the catalogue on device.
 * The output is committed — the app must build without the backend tree.
 *
 * Only the fields the ranking reads survive (id, name_ko, modality, equipment,
 * primary_muscles, contraindication_tags): ~0.2MB → ~0.1MB. `app/test/plan_edit_test.dart`
 * asserts id/name_ko parity with `src/data/exercises.json`, so the copy cannot rot
 * unnoticed.
 */
const fs = require("node:fs");
const path = require("node:path");

const SOURCE = path.join(__dirname, "..", "src", "data", "exercises.json");
const OUT = path.join(__dirname, "..", "..", "app", "assets", "exercises.json");

const out = JSON.parse(fs.readFileSync(SOURCE, "utf8")).map((e) => ({
  id: e.id,
  name_ko: e.name_ko,
  modality: e.modality,
  equipment: e.equipment,
  primary_muscles: e.primary_muscles,
  contraindication_tags: e.contraindication_tags,
}));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(out, null, 0)}\n`, "utf8");
console.log(`${out.length} exercises → ${OUT} (${fs.statSync(OUT).size} bytes)`);
