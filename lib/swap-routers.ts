/** Known Aquarius router contract ids (swap uses Default context rule, not per-router rules). */
export const SWAP_ROUTER_CONTRACTS: Record<"testnet" | "mainnet", string> = {
  testnet: "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD",
  mainnet: "CBQDHNBFBZYE4MKPWBSJOPIYLW4SFSXAXUTSXJN76GNKYVYPCKWC6QUK",
};

export function isSwapRouterContractId(contractId: string): boolean {
  return Object.values(SWAP_ROUTER_CONTRACTS).includes(contractId);
}
