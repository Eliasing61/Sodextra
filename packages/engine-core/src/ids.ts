import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

/** 8-character lowercase bot ID, e.g. "k3f9x0aa". */
export function newBotId(): string {
  const bytes = randomBytes(8);
  let id = "";
  for (const b of bytes) id += ALPHABET[b % ALPHABET.length];
  return id;
}

/**
 * Client order IDs: `sx<prefix>-<botId>-<seq base36>`, e.g. "sxg-k3f9x0aa-1f".
 * The bot ID lets us recognise our own orders on the exchange after a restart
 * (clOrdID is unique among an account's open orders, max 36 chars).
 */
export function clOrdId(prefix: string, botId: string, seq: number): string {
  const id = `sx${prefix}-${botId}-${seq.toString(36)}`;
  if (id.length > 36) throw new Error(`clOrdID too long: ${id}`);
  return id;
}

export function botOrderPrefix(prefix: string, botId: string): string {
  return `sx${prefix}-${botId}-`;
}
