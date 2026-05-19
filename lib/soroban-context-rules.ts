import {
  Account,
  Contract,
  Keypair,
  rpc,
  scValToNative,
  TransactionBuilder,
  xdr,
} from "@stellar/stellar-sdk";

export type ContextRuleDiscovery = "matched" | "default" | "fallback";

export type DiscoverContextRuleResult = {
  contextRuleId: number;
  discovery: ContextRuleDiscovery;
};

/** scValToNative returns Rust enums as `["Variant", ...]` or `{ Variant: ... }`. */
function extractCallContractAddress(ctxType: unknown): string | null {
  if (Array.isArray(ctxType)) {
    const [variant, payload] = ctxType;
    if (variant === "CallContract" && typeof payload === "string") {
      return payload;
    }
    return null;
  }
  if (!ctxType || typeof ctxType !== "object") return null;
  const o = ctxType as Record<string, unknown>;
  const addr =
    o.CallContract ?? o.callContract ?? o.Contract ?? o.contract;
  if (typeof addr === "string") return addr;
  return null;
}

function isDefaultContext(ctxType: unknown): boolean {
  if (Array.isArray(ctxType)) {
    return ctxType[0] === "Default";
  }
  if (!ctxType || typeof ctxType !== "object") return false;
  const o = ctxType as Record<string, unknown>;
  return "Default" in o || "default" in o;
}

/**
 * Find a context rule id for invoking `targetContractId` on a smart account.
 * Prefers CallContract(target); falls back to Default; else id 0.
 */
export async function discoverContextRule(
  server: rpc.Server,
  networkPassphrase: string,
  smartAccountAddress: string,
  targetContractId: string
): Promise<DiscoverContextRuleResult> {
  let fallbackId = 0;
  let defaultId: number | null = null;

  try {
    const smartAccount = new Contract(smartAccountAddress);
    const dummyKp = Keypair.random();
    const dummyAccount = new Account(dummyKp.publicKey(), "0");

    const countTx = new TransactionBuilder(dummyAccount, {
      fee: "100",
      networkPassphrase,
    })
      .addOperation(smartAccount.call("get_context_rules_count"))
      .setTimeout(30)
      .build();

    const countSim = await server.simulateTransaction(countTx);
    if (!rpc.Api.isSimulationSuccess(countSim)) {
      return { contextRuleId: 0, discovery: "fallback" };
    }

    const count = Number(scValToNative(countSim.result!.retval));
    for (let id = 0; id < count; id++) {
      const ruleTx = new TransactionBuilder(dummyAccount, {
        fee: "100",
        networkPassphrase,
      })
        .addOperation(smartAccount.call("get_context_rule", xdr.ScVal.scvU32(id)))
        .setTimeout(30)
        .build();
      const ruleSim = await server.simulateTransaction(ruleTx);
      if (!rpc.Api.isSimulationSuccess(ruleSim)) continue;

      const ruleNative: Record<string, unknown> = scValToNative(
        ruleSim.result!.retval
      ) as Record<string, unknown>;
      const ctxType =
        ruleNative?.context_type ?? ruleNative?.contextType ?? ruleNative?.context;

      if (isDefaultContext(ctxType) && defaultId === null) {
        defaultId = id;
      }

      const callAddr = extractCallContractAddress(ctxType);
      if (callAddr === targetContractId) {
        return { contextRuleId: id, discovery: "matched" };
      }
    }

    if (defaultId !== null) {
      return { contextRuleId: defaultId, discovery: "default" };
    }
  } catch {
    // fall through
  }

  return { contextRuleId: fallbackId, discovery: "fallback" };
}

export function hasMatchedCallContractRule(discovery: ContextRuleDiscovery): boolean {
  return discovery === "matched";
}
