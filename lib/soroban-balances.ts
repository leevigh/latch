import {
  Account,
  Address,
  Contract,
  Keypair,
  rpc,
  scValToNative,
  StrKey,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";
import type { CatalogAsset } from "@/lib/stellar-assets";
import { formatAmountFromI128 } from "@/lib/stellar-assets";

export type AssetBalance = {
  assetId: string;
  symbol: string;
  name: string;
  contractId: string;
  decimals: number;
  balance: string;
  balanceRaw: string;
};

function scValToBigInt(val: xdr.ScVal): bigint {
  const native = scValToNative(val);
  if (typeof native === "bigint") return native;
  if (typeof native === "number") return BigInt(Math.trunc(native));
  if (typeof native === "string") return BigInt(native);
  if (native && typeof native === "object" && "hi" in native && "lo" in native) {
    const parts = native as { hi?: unknown; lo?: unknown };
    const hi = BigInt(String(parts.hi ?? 0));
    const lo = BigInt(String(parts.lo ?? 0));
    return (hi << 64n) + lo;
  }
  throw new Error("Unsupported balance ScVal shape");
}

export async function fetchSacBalance(
  server: rpc.Server,
  networkPassphrase: string,
  tokenContractId: string,
  holderAddress: string
): Promise<bigint> {
  if (!StrKey.isValidContract(tokenContractId)) {
    console.warn(
      `[soroban-balances] Skipping invalid SAC contract id: ${tokenContractId}`
    );
    return 0n;
  }

  const token = new Contract(tokenContractId);
  const dummyKp = Keypair.random();
  const dummyAccount = new Account(dummyKp.publicKey(), "0");

  const tx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(token.call("balance", new Address(holderAddress).toScVal()))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    return 0n;
  }
  if (!rpc.Api.isSimulationSuccess(sim) || !sim.result?.retval) {
    return 0n;
  }

  try {
    return scValToBigInt(sim.result.retval);
  } catch {
    return 0n;
  }
}

export async function fetchBalancesForCatalog(
  server: rpc.Server,
  networkPassphrase: string,
  holderAddress: string,
  catalog: CatalogAsset[],
  nonZeroOnly = true
): Promise<AssetBalance[]> {
  const results: AssetBalance[] = [];

  for (const asset of catalog) {
    try {
      const raw = await fetchSacBalance(
        server,
        networkPassphrase,
        asset.contractId,
        holderAddress
      );
      if (nonZeroOnly && raw === 0n) continue;

      results.push({
      assetId: asset.assetId,
      symbol: asset.symbol,
      name: asset.name,
      contractId: asset.contractId,
      decimals: asset.decimals,
      balance: formatAmountFromI128(raw, asset.decimals),
      balanceRaw: raw.toString(),
      });
    } catch (err) {
      console.warn(
        `[soroban-balances] Failed balance for ${asset.assetId} (${asset.contractId}):`,
        err instanceof Error ? err.message : err
      );
    }
  }

  return results;
}
