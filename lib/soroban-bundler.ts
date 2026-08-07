import { Keypair, rpc } from "@stellar/stellar-sdk";

export async function fundAccountIfNeeded(gAddress: string): Promise<void> {
  try {
    const horizonResponse = await fetch(
      `https://horizon-testnet.stellar.org/accounts/${gAddress}`
    );
    if (horizonResponse.ok) return;
  } catch {
    // ignore
  }
  const response = await fetch(
    `https://friendbot.stellar.org?addr=${encodeURIComponent(gAddress)}`
  );
  if (!response.ok) {
    throw new Error(`Failed to fund account: ${response.statusText}`);
  }
}

export async function getBundlerAccount(
  server: rpc.Server,
  bundlerKeypair: Keypair
) {
  try {
    return await server.getAccount(bundlerKeypair.publicKey());
  } catch (e: unknown) {
    const msg = String(e instanceof Error ? e.message : e);
    if (msg.includes("Account not found")) {
      await fundAccountIfNeeded(bundlerKeypair.publicKey());
      return await server.getAccount(bundlerKeypair.publicKey());
    }
    throw e;
  }
}
