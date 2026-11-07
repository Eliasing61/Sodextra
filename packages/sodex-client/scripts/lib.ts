// Shared helpers for the smoke-test scripts. Loads the repo-root .env (never committed).

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ActionSigner, type Address, type Hex, type Network } from "../src/index.ts";

const envPath = fileURLToPath(new URL("../../../.env", import.meta.url));
if (existsSync(envPath)) process.loadEnvFile(envPath);

export const env = {
  network: (process.env.SODEX_NETWORK || "mainnet") as Network,
  userAddress: (process.env.SODEX_USER_ADDRESS || undefined) as Address | undefined,
  accountId: process.env.SODEX_ACCOUNT_ID ? Number(process.env.SODEX_ACCOUNT_ID) : undefined,
  apiKeyName: process.env.SODEX_API_KEY_NAME || undefined,
  apiKeyPrivateKey: (process.env.SODEX_API_KEY_PRIVATE_KEY || undefined) as Hex | undefined,
};

if (env.network !== "mainnet" && env.network !== "testnet") {
  throw new Error(`SODEX_NETWORK must be mainnet or testnet (got ${env.network})`);
}
if (env.userAddress && !/^0x[0-9a-fA-F]{40}$/.test(env.userAddress)) {
  throw new Error("SODEX_USER_ADDRESS must be a 0x-prefixed 40-hex-character address");
}

export function makeSigner(): ActionSigner {
  if (!env.apiKeyName || !env.apiKeyPrivateKey) {
    throw new Error("Set SODEX_API_KEY_NAME and SODEX_API_KEY_PRIVATE_KEY in .env");
  }
  return new ActionSigner({ privateKey: env.apiKeyPrivateKey, apiKeyName: env.apiKeyName });
}

let failures = 0;

export async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const result = await fn();
    console.log(`  ✓ ${label}`);
    return result;
  } catch (error) {
    failures += 1;
    console.log(`  ✗ ${label}\n      ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

export function info(text: string): void {
  console.log(`      ${text}`);
}

export function section(title: string): void {
  console.log(`\n${title}`);
}

export function finish(): void {
  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exitCode = failures === 0 ? 0 : 1;
}

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Retry `check` until it stops throwing or the timeout passes. History and trade
 * endpoints update a few seconds after open orders do, so one-shot checks are flaky.
 */
export async function eventually<T>(check: () => Promise<T>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await sleep(1_000);
    }
  }
}
