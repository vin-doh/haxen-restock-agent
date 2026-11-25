// CLI-only: reads .env into process.env. Kept out of config.ts so the web app never reads files.
import { readFileSync, existsSync } from "node:fs";

/** Loads KEY=VALUE lines from .env into process.env (without overriding real env vars). */
export function loadDotEnv(path = ".env"): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    const [, key, raw] = m as unknown as [string, string, string];
    if (process.env[key] === undefined) process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}
