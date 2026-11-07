export type Network = "mainnet" | "testnet";

/** SoDEX runs two matching engines with separate REST paths, WS endpoints and signing domains. */
export type Engine = "spot" | "perps";

export interface NetworkConfig {
  name: Network;
  /** REST root, e.g. https://mainnet-gw.sodex.dev (paths start with /api/v1). */
  restBaseUrl: string;
  /** WS root; engine streams live at `${wsBaseUrl}/ws/{spot|perps}`. */
  wsBaseUrl: string;
  /** ValueChain chain ID used in EIP-712 domains and the X-API-Chain header. */
  chainId: number;
}

export const NETWORKS: Record<Network, NetworkConfig> = {
  mainnet: {
    name: "mainnet",
    restBaseUrl: "https://mainnet-gw.sodex.dev",
    wsBaseUrl: "wss://mainnet-gw.sodex.dev",
    chainId: 286623,
  },
  testnet: {
    name: "testnet",
    restBaseUrl: "https://testnet-gw.sodex.dev",
    wsBaseUrl: "wss://testnet-gw.sodex.dev",
    chainId: 138565,
  },
};

export function resolveNetwork(network: Network | NetworkConfig): NetworkConfig {
  return typeof network === "string" ? NETWORKS[network] : network;
}
