import {
  Account,
  Address,
  Contract,
  TransactionBuilder,
  rpc,
} from "@stellar/stellar-sdk";
import {
  goApiBase,
  SignDemoApiError,
  isSignDemoApiError,
} from "@/lib/sign-demo/api";
import type { Network } from "@/lib/sign-demo/types";
import { resolveNetwork } from "@/lib/network";

export { goApiBase, SignDemoApiError, isSignDemoApiError };

export const COUNTER_CONTRACT_ID =
  process.env.NEXT_PUBLIC_COUNTER_ADDRESS ||
  "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U";

export type BuildCounterRequest = {
  smartAccountAddress: string;
  signerG?: string;
};

export type BuildCounterResponse = {
  txXdr: string;
  authEntryXdr?: string;
  authEntriesXdr?: string[];
  smartAccountAuthEntryIndex?: number;
  contextRuleId?: number | string;
  contextRuleDiscovery?: string;
  authDigestHex?: string;
  signaturePayloadHex?: string;
  validUntilLedger?: number;
  simulationResultXdr?: string;
  [key: string]: unknown;
};

async function goFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${goApiBase()}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data as { message?: string; error?: string }).message ??
      (data as { error?: string }).error ??
      `Request failed: ${res.status}`;
    const code = (data as { code?: string }).code ?? "request_failed";
    const suggestedAction = (data as { suggestedAction?: string })
      .suggestedAction;
    throw new SignDemoApiError(code, msg, res.status, suggestedAction);
  }
  return data as T;
}

/** Read demo counter value from Go production backend. */
export async function getCounter(): Promise<{ value: number }> {
  return goFetch<{ value: number }>("/api/counter");
}

/**
 * Go `/api/transaction/build` returns an auth-ready envelope (auth + Soroban
 * data attached). `window.latch.signTransaction` always re-runs
 * `/api/transaction/prepare-sign`, which only accepts a raw unsigned invoke.
 * Passing the build XDR causes `[internal_error] failed to prepare transaction`.
 *
 * Rebuild the same `counter.increment` op without auth/ext so the wallet can
 * prepare-sign safely.
 */
export function toExtensionSignableTxXdr(
  assembledTxXdr: string,
  network: Network,
  smartAccountAddress: string
): string {
  const { networkPassphrase } = resolveNetwork(network);
  const assembled = TransactionBuilder.fromXDR(
    assembledTxXdr,
    networkPassphrase
  );
  const account = new Account(
    assembled.source,
    String(BigInt(assembled.sequence) - 1n)
  );
  const contract = new Contract(COUNTER_CONTRACT_ID);
  return new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase,
  })
    .addOperation(
      contract.call(
        "increment",
        Address.fromString(smartAccountAddress).toScVal()
      )
    )
    .setTimeout(300)
    .build()
    .toXDR();
}

/**
 * Build a raw unsigned counter.increment XDR for `window.latch.signTransaction`.
 * Uses `NEXT_PUBLIC_LATCH_FEE_PAYER_G` when set; otherwise Go `/build` + strip.
 */
export async function buildCounterIncrementForExtension(args: {
  smartAccountAddress: string;
  network: Network;
  signerG?: string;
}): Promise<{ unsignedTxXdr: string; source: "local" | "go-build-strip" }> {
  const feePayerG = process.env.NEXT_PUBLIC_LATCH_FEE_PAYER_G?.trim();
  if (feePayerG?.startsWith("G")) {
    const { rpcUrl, networkPassphrase } = resolveNetwork(args.network);
    const server = new rpc.Server(rpcUrl);
    const account = await server.getAccount(feePayerG);
    const contract = new Contract(COUNTER_CONTRACT_ID);
    const unsignedTxXdr = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase,
    })
      .addOperation(
        contract.call(
          "increment",
          Address.fromString(args.smartAccountAddress).toScVal()
        )
      )
      .setTimeout(300)
      .build()
      .toXDR();
    return { unsignedTxXdr, source: "local" };
  }

  const built = await goFetch<BuildCounterResponse>("/api/transaction/build", {
    method: "POST",
    body: JSON.stringify({
      smartAccountAddress: args.smartAccountAddress,
      ...(args.signerG ? { signerG: args.signerG } : {}),
    }),
  });
  if (!built.txXdr) {
    throw new Error("Go /api/transaction/build returned no txXdr.");
  }
  return {
    unsignedTxXdr: toExtensionSignableTxXdr(
      built.txXdr,
      args.network,
      args.smartAccountAddress
    ),
    source: "go-build-strip",
  };
}

/** Auth-ready Go build (not for extension signTransaction / prepare-sign). */
export async function buildCounterIncrement(
  body: BuildCounterRequest
): Promise<BuildCounterResponse> {
  return goFetch<BuildCounterResponse>("/api/transaction/build", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
