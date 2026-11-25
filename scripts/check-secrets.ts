// Fails if a staged file looks like it contains a private key or an API secret.
// Runs as a Git pre-commit hook (see scripts/install-hooks.ts) and in CI.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PATTERNS: Array<[string, RegExp]> = [
  ["32-byte hex private key", /(?<![0-9a-fA-F])(?:0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/],
  ["PRIVATE_KEY with a value", /PRIVATE_KEY\s*=\s*\S+/],
  ["API key with a value", /(?:API_KEY|SECRET|TOKEN)\s*=\s*[A-Za-z0-9_\-]{12,}/],
  ["PEM private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
// Public 32-byte values that are allowed (event topics, the ERC-8021 marker, etc.).
const ALLOWED = [/0x80218021802180218021802180218021/i, /ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef/i];

const all = process.argv.includes("--all");
const files = execFileSync("git", all ? ["ls-files"] : ["diff", "--cached", "--name-only", "--diff-filter=ACM"], { encoding: "utf8" })
  .split("\n").map((f) => f.trim()).filter(Boolean)
  .filter((f) => !f.startsWith("node_modules/") && f !== "package-lock.json");

const hits: string[] = [];
for (const file of files) {
  if (/^\.env(\.|$)/.test(file) && file !== ".env.example") { hits.push(`${file}: env files must never be committed`); continue; }
  let text: string;
  try { text = readFileSync(file, "utf8"); } catch { continue; }
  text.split("\n").forEach((line, i) => {
    if (ALLOWED.some((re) => re.test(line))) return;
    for (const [name, re] of PATTERNS) if (re.test(line)) hits.push(`${file}:${i + 1}: looks like a ${name}`);
  });
}
if (hits.length) {
  console.error("Refusing to commit: possible secrets found.\n" + hits.join("\n"));
  console.error("If one of these is a public value (a tx hash, a contract topic), add it to ALLOWED in scripts/check-secrets.ts.");
  process.exit(1);
}
console.log(`check-secrets: ${files.length} file(s) clean.`);
