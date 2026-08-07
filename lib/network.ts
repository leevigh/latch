import { Networks } from "@stellar/stellar-sdk";

export type Network = "testnet" | "mainnet";

export type NetworkConfig = {
  network: Network;
  rpcUrl: string;
  networkPassphrase: string;
};

export class NetworkConfigError extends Error {
  code = "invalid_network" as const;

  constructor(message: string) {
    super(message);
    this.name = "NetworkConfigError";
  }
}

const NETWORKS = new Set<Network>(["testnet", "mainnet"]);

export function isNetwork(value: unknown): value is Network {
  return typeof value === "string" && NETWORKS.has(value as Network);
}

export function resolveNetwork(network: Network): NetworkConfig {
  if (network === "testnet") {
    return {
      network: "testnet",
      rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
      networkPassphrase:
        process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
    };
  }

  const rpcUrl = process.env.MAINNET_RPC_URL?.trim();
  const networkPassphrase = process.env.MAINNET_NETWORK_PASSPHRASE?.trim();

  if (!rpcUrl || !networkPassphrase) {
    throw new NetworkConfigError(
      "Mainnet is not configured. Set MAINNET_RPC_URL and MAINNET_NETWORK_PASSPHRASE."
    );
  }

  return { network: "mainnet", rpcUrl, networkPassphrase };
}
