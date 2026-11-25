// Installs a pre-commit hook that runs the secret check before every commit.
import { writeFileSync, chmodSync } from "node:fs";
const hook = "#!/bin/sh\nnode scripts/check-secrets.ts || exit 1\n";
writeFileSync(".git/hooks/pre-commit", hook);
try { chmodSync(".git/hooks/pre-commit", 0o755); } catch {}
console.log("pre-commit secret check installed.");
