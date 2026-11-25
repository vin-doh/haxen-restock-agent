// CLI-only: saves the granted session (never the key) to disk and loads it back.
import { deserializeSession, serializeSession, signerFromPrivateKey, type Session } from "@altananetwork/sdk";
import type { Hex } from "viem";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

export function saveSession(path: string, session: Session): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(serializeSession(session), null, 2));
}

export function loadSession(path: string, sessionKey: Hex): Session {
  if (!existsSync(path)) throw new Error(`No session at ${path}. The owner runs "owner:grant" first.`);
  return deserializeSession(JSON.parse(readFileSync(path, "utf8")), signerFromPrivateKey(sessionKey));
}
