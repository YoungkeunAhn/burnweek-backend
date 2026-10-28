#!/usr/bin/env node
/**
 * Downloads the free-exercise-db action photos (public domain / Unlicense) and
 * writes them to `public/ex/<canonical id>/{0,1}.webp` for Firebase Hosting:
 *
 *   node scripts/build-exercise-images.cjs
 *
 * Every one of the 873 exercises upstream has exactly two frames (start / end),
 * which is the two-panel layout the reference app shows. Originals are 850x567
 * JPEG at ~70KB; we re-encode to 520px WebP (~16KB) because the client shows two
 * side by side inside a 560px card — 520px still covers a 2x display.
 *
 * **Named by canonical id, so the client needs no lookup table.** Upstream folder
 * names are TitleCase (`Wide-Grip_Lat_Pulldown`) and `canonicalId` is lossy, so
 * re-deriving the URL client-side would need a 25KB map shipped in the bundle.
 * Renaming here costs nothing and the URL becomes `/ex/${exercise_id}/0.webp`.
 *
 * Output is committed (~28MB) for the same reason `exercises.json` is: deploys
 * must not depend on an upstream that can move or vanish.
 *
 * Requires `ffmpeg` on PATH (encode only — no npm dependency for a script that
 * runs once).
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const run = promisify(execFile);
const SOURCE = "https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/dist/exercises.json";
// jsDelivr, not raw.githubusercontent — 1,746 files in one run is bulk traffic
// and the CDN is what it is for.
const CDN = "https://cdn.jsdelivr.net/gh/yuhonas/free-exercise-db@main/exercises";
const OUT = path.join(__dirname, "..", "public", "ex");
const WIDTH = 520;
const QUALITY = 60;
const CONCURRENCY = 6;

/** `3_4_Sit-Up` → `3_4_sit_up`. Same rule as `build-exercise-db.cjs`. */
function canonicalId(id) {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
}

async function fetchBuffer(url) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const res = await fetch(url);
    if (res.ok) return Buffer.from(await res.arrayBuffer());
    if (res.status === 404) return null; // 목록에 있으나 파일이 없는 것 — 건너뛴다
    if (attempt === 3) throw new Error(`${res.status} ${url}`);
  }
  return null;
}

async function one(job, tmpDir) {
  const dest = path.join(OUT, job.id, `${job.index}.webp`);
  if (fs.existsSync(dest)) return "skip"; // 중간에 끊겨도 이어서 받는다
  const jpg = await fetchBuffer(`${CDN}/${job.remote}`);
  if (!jpg) return "missing";
  const tmp = path.join(tmpDir, `${job.id}-${job.index}.jpg`);
  fs.writeFileSync(tmp, jpg);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await run("ffmpeg", ["-y", "-loglevel", "error", "-i", tmp,
    "-vf", `scale=${WIDTH}:-1`, "-c:v", "libwebp", "-quality", String(QUALITY), dest]);
  fs.unlinkSync(tmp);
  return "ok";
}

async function main() {
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
  const upstream = await res.json();

  const jobs = [];
  for (const e of upstream) {
    for (const [index, remote] of (e.images ?? []).entries()) {
      jobs.push({ id: canonicalId(e.id), index, remote });
    }
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eximg-"));
  const tally = { ok: 0, skip: 0, missing: 0 };
  let next = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      tally[await one(job, tmpDir)] += 1;
      const done = tally.ok + tally.skip + tally.missing;
      if (done % 200 === 0) console.log(`${done}/${jobs.length}`);
    }
  }));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  console.log(`${JSON.stringify(tally)} → ${OUT}`);
  if (tally.missing > 0) console.log(`※ ${tally.missing}장은 업스트림에 없다 — 화면은 있는 것만 보인다`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
