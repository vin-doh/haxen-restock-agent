// Owner-side actions. These need OWNER_PRIVATE_KEY and are meant to run on the owner's
// machine, not where the agent runs.
import { signerFromPrivateKey, type Session } from "@altananetwork/sdk";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { TOKENS } from "../config.ts";
import type { ProofSigner } from "../fx/textile.ts";
import { makeAltanaClient, restockPermissions } from "./altana.ts";
import { saveSession } from "./session-store.ts";

export function ownerWallet(ownerKey: Hex) {
  const signer = signerFromPrivateKey(ownerKey);
  // Under EIP-7702 the smart-account address is the owner's EOA address.
  return { signer, wallet: { address: privateKeyToAccount(ownerKey).address } };
}

/** Grants the agent a session key: allowlisted calls only, daily caps, expiry. Writes the key to .env and the session to disk. */
export async function grantAgentSession(p: {
  ownerKey: Hex;
  attributionCode: string;
  usdtPerDay: bigint;
  cngnPerDay: bigint;
  days: number;
  sessionPath: string;
  envPath?: string;
  log?: (s: string) => void;
}): Promise<Session> {
  const log = p.log ?? (() => {});
  const client = makeAltanaClient(p.attributionCode);
  const { signer, wallet } = ownerWallet(p.ownerKey);
  const sessionKey = generatePrivateKey();
  // Write the key before granting: if the process dies mid-grant, the key isn't lost.
  setEnvVar(p.envPath ?? ".env", "SESSION_PRIVATE_KEY", sessionKey);
  const result = await client.grantSession({
    wallet,
    signer,
    permissions: restockPermissions({ usdtPerDay: p.usdtPerDay, cngnPerDay: p.cngnPerDay }),
    expiry: Math.floor(Date.now() / 1000) + p.days * 24 * 3600,
    sessionSigner: signerFromPrivateKey(sessionKey),
    feeToken: TOKENS.USDT.address,
    onStatus: (s) => log(`grant: ${s}`),
  });
  if (result.status !== "granted") throw new Error(`Session grant did not confirm (status ${result.status})`);
  saveSession(p.sessionPath, result);
  log(`Session granted in ${result.transactionHash ?? "(bundled)"}; key saved to .env, session to ${p.sessionPath}`);
  return result;
}

export async function revokeAgentSession(p: { ownerKey: Hex; attributionCode: string; session: Session }) {
  const client = makeAltanaClient(p.attributionCode);
  const { signer, wallet } = ownerWallet(p.ownerKey);
  return client.revokeSession({ wallet, signer, session: p.session, feeToken: TOKENS.USDT.address });
}

/**
 * Signs Textile's "Taker Control" proof with the owner key. The proof lets Textile quote for the
 * wallet for ~12h. It cannot move funds: only the session-capped wallet can send the swap.
 */
export function ownerProofSigner(ownerKey: Hex): ProofSigner {
  const account = privateKeyToAccount(ownerKey);
  return (typed) => account.signTypedData(typed);
}

/** Sets KEY=value in an env file without printing it. */
export function setEnvVar(path: string, key: string, value: string): void {
  const lines = existsSync(path) ? readFileSync(path, "utf8").split(/\r?\n/) : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
  writeFileSync(path, lines.join("\n").replace(/\n*$/, "\n"), { mode: 0o600 });
}
