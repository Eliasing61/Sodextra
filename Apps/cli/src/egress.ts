import { isIP } from "node:net";

import { Agent, setGlobalDispatcher } from "undici";

/**
 * Send this process's SoDEX traffic (REST and WebSocket) from one of the server's own
 * addresses. SoDEX allows 10 users and 10 connections per IP, so the dashboard API gives
 * each bot an address (SODEXTRA_EGRESS_IP) and fills every address up to 10 people.
 * Node's built-in fetch and WebSocket both go through undici's global dispatcher.
 */
export function useEgress(address: string | undefined): void {
  if (!address) return;
  setGlobalDispatcher(new Agent(egressAgentOptions(address)));
}

/**
 * Agent options that bind to `address`. The address must be a top-level option: undici
 * overwrites a `localAddress` given inside `connect`. Looking up only the address's own
 * family keeps an IPv6 address from trying SoDEX's IPv4 address (and the reverse).
 */
export function egressAgentOptions(address: string): {
  localAddress: string;
  autoSelectFamily: false;
  connect: { family: 4 | 6 };
} {
  const family = isIP(address);
  if (family !== 4 && family !== 6) {
    throw new Error(`SODEXTRA_EGRESS_IP "${address}" is not an IP address`);
  }
  return { localAddress: address, autoSelectFamily: false, connect: { family } };
}
