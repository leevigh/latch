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

export type ContextRuleSignerSummary = {
  kind: "External" | "Delegated" | "Other";
  verifierAddress?: string;
  gAddress?: string;
  /** Raw External signer key_data bytes (hex), when present on chain. */
  keyDataHex?: string;
};

function bytesToHex(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString("hex");
  }
  return undefined;
}

export type ContextRuleSummary = {
  id: number;
  name?: string;
  contextType: unknown;
  callContractAddress?: string;
  signers: ContextRuleSignerSummary[];
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
    const batchSize = 5;

    for (let start = 0; start < count; start += batchSize) {
      const end = Math.min(start + batchSize, count);
      const ctxTypes = await Promise.all(
        Array.from({ length: end - start }, (_, offset) =>
          simulateContextRuleType(
            server,
            networkPassphrase,
            smartAccount,
            dummyAccount,
            start + offset
          )
        )
      );

      for (let offset = 0; offset < ctxTypes.length; offset++) {
        const id = start + offset;
        const ctxType = ctxTypes[offset];
        if (ctxType === null) continue;

        if (isDefaultContext(ctxType) && defaultId === null) {
          defaultId = id;
        }

        const callAddr = extractCallContractAddress(ctxType);
        if (callAddr === targetContractId) {
          return { contextRuleId: id, discovery: "matched" };
        }
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

/** Context rule id for Default (smart-account admin ops such as add_signer). */
export async function discoverDefaultContextRule(
  server: rpc.Server,
  networkPassphrase: string,
  smartAccountAddress: string
): Promise<DiscoverContextRuleResult> {
  try {
    const rules = await listContextRules(server, networkPassphrase, smartAccountAddress);
    const defaultRule = rules.find((r) => isDefaultContext(r.contextType));
    if (defaultRule) {
      return { contextRuleId: defaultRule.id, discovery: "default" };
    }
  } catch {
    // fall through
  }
  return { contextRuleId: 0, discovery: "fallback" };
}

async function simulateContextRuleType(
  server: rpc.Server,
  networkPassphrase: string,
  smartAccount: Contract,
  dummyAccount: Account,
  ruleId: number
): Promise<unknown | null> {
  const ruleTx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(smartAccount.call("get_context_rule", xdr.ScVal.scvU32(ruleId)))
    .setTimeout(30)
    .build();
  const ruleSim = await server.simulateTransaction(ruleTx);
  if (!rpc.Api.isSimulationSuccess(ruleSim)) return null;

  const ruleNative: Record<string, unknown> = scValToNative(
    ruleSim.result!.retval
  ) as Record<string, unknown>;
  return ruleNative?.context_type ?? ruleNative?.contextType ?? ruleNative?.context;
}

function parseSignerSummary(signer: unknown): ContextRuleSignerSummary {
  if (Array.isArray(signer)) {
    const [variant, ...rest] = signer;
    if (variant === "External" && typeof rest[0] === "string") {
      return {
        kind: "External",
        verifierAddress: rest[0],
        keyDataHex: bytesToHex(rest[1]),
      };
    }
    if (variant === "Delegated" && typeof rest[0] === "string") {
      return { kind: "Delegated", gAddress: rest[0] };
    }
  }
  if (signer && typeof signer === "object") {
    const o = signer as Record<string, unknown>;
    if (typeof o.External === "string") {
      return { kind: "External", verifierAddress: o.External };
    }
    if (Array.isArray(o.External) && typeof o.External[0] === "string") {
      return {
        kind: "External",
        verifierAddress: o.External[0],
        keyDataHex: bytesToHex(o.External[1]),
      };
    }
    if (typeof o.Delegated === "string") {
      return { kind: "Delegated", gAddress: o.Delegated };
    }
  }
  return { kind: "Other" };
}

function parseRuleSigners(ruleNative: Record<string, unknown>): ContextRuleSignerSummary[] {
  const signersRaw =
    ruleNative?.signers ?? ruleNative?.signers_vec ?? ruleNative?.signersVec;
  if (!Array.isArray(signersRaw)) return [];
  return signersRaw.map(parseSignerSummary);
}

/** List all context rules on a smart account (read-only simulation). */
export async function listContextRules(
  server: rpc.Server,
  networkPassphrase: string,
  smartAccountAddress: string
): Promise<ContextRuleSummary[]> {
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
    return [];
  }

  const count = Number(scValToNative(countSim.result!.retval));
  const rules: ContextRuleSummary[] = [];

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
    const name = ruleNative?.name as string | undefined;

    rules.push({
      id,
      name,
      contextType: ctxType,
      callContractAddress: extractCallContractAddress(ctxType) ?? undefined,
      signers: parseRuleSigners(ruleNative),
    });
  }

  return rules;
}

/** Fetch a single context rule by id (one RPC simulate). */
export async function fetchContextRuleAtId(
  server: rpc.Server,
  networkPassphrase: string,
  smartAccountAddress: string,
  ruleId: number
): Promise<ContextRuleSummary | null> {
  const smartAccount = new Contract(smartAccountAddress);
  const dummyKp = Keypair.random();
  const dummyAccount = new Account(dummyKp.publicKey(), "0");

  const ruleTx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(smartAccount.call("get_context_rule", xdr.ScVal.scvU32(ruleId)))
    .setTimeout(30)
    .build();

  const ruleSim = await server.simulateTransaction(ruleTx);
  if (!rpc.Api.isSimulationSuccess(ruleSim)) return null;

  const ruleNative: Record<string, unknown> = scValToNative(
    ruleSim.result!.retval
  ) as Record<string, unknown>;
  const ctxType =
    ruleNative?.context_type ?? ruleNative?.contextType ?? ruleNative?.context;
  const name = ruleNative?.name as string | undefined;

  return {
    id: ruleId,
    name,
    contextType: ctxType,
    callContractAddress: extractCallContractAddress(ctxType) ?? undefined,
    signers: parseRuleSigners(ruleNative),
  };
}

/** Fetch a single context rule by id. */
export async function getContextRule(
  server: rpc.Server,
  networkPassphrase: string,
  smartAccountAddress: string,
  ruleId: number
): Promise<ContextRuleSummary | null> {
  return fetchContextRuleAtId(server, networkPassphrase, smartAccountAddress, ruleId);
}

export function ruleHasOnlyDelegatedG(
  rule: ContextRuleSummary,
  gAddress: string
): boolean {
  if (rule.signers.length === 0) return false;
  return rule.signers.every(
    (s) => s.kind === "Delegated" && s.gAddress === gAddress
  );
}

export function ruleHasExternalSigner(rule: ContextRuleSummary): boolean {
  return rule.signers.some((s) => s.kind === "External");
}

export function ruleHasDelegatedSigner(
  rule: ContextRuleSummary,
  gAddress: string
): boolean {
  return rule.signers.some(
    (s) => s.kind === "Delegated" && s.gAddress === gAddress
  );
}

export function ruleHasExternalPasskey(
  rule: ContextRuleSummary,
  verifierAddress?: string
): boolean {
  return rule.signers.some((s) => {
    if (s.kind !== "External") return false;
    if (verifierAddress && s.verifierAddress !== verifierAddress) return false;
    const hex = s.keyDataHex?.trim().toLowerCase();
    return Boolean(hex && hex.length >= 132 && hex.startsWith("04"));
  });
}

export function isBundlerOnlyDelegatedRule(
  rule: ContextRuleSummary,
  bundlerPublicKey: string
): boolean {
  return ruleHasOnlyDelegatedG(rule, bundlerPublicKey) && !ruleHasExternalSigner(rule);
}

/** Find WebAuthn key_data already registered on any context rule (e.g. send rules). */
export function findWebauthnKeyDataInRules(
  rules: ContextRuleSummary[],
  webauthnVerifier?: string
): string | null {
  for (const rule of rules) {
    for (const signer of rule.signers) {
      if (signer.kind !== "External" || !signer.keyDataHex) continue;
      if (webauthnVerifier && signer.verifierAddress !== webauthnVerifier) continue;
      const hex = signer.keyDataHex.trim().toLowerCase();
      if (hex.length >= 132 && hex.startsWith("04")) {
        return hex;
      }
    }
  }
  return null;
}
