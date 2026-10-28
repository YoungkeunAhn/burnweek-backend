/**
 * .env loader for the live (opt-in) tests. Same 5-line parse as
 * `scripts/run-local.cjs`; no dotenv dependency.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function loadEnv(): void {
  // `.env.local` holds the key (never deployed); `.env` holds the non-secret
  // config that `firebase deploy` turns into the function's env vars.
  for (const name of [".env.local", ".env"]) {
    const path = join(__dirname, "..", name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      if (line.trim().startsWith("#")) continue;
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}
