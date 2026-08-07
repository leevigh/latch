import * as crypto from "crypto";
import {
  Address,
  Operation,
  rpc,
  Transaction,
  xdr,
  hash,
} from "@stellar/stellar-sdk";
import { assembleTransaction } from "@stellar/stellar-sdk/rpc";
import {
  computeAuthDigest,
  computeAuthDigestHex,
  contextRuleIdsForEntry,
  hashSorobanAuthPayload,
} from "@/lib/soroban-auth-payload";
import {
  addressStringFromCredentials,
  classifyAuthEntryRole,
  credentialSwitchName,
  normalizeAuthEntries,
  rootInvocationSummary,
  setAddressCredentialExpiration,
} from "@/lib/soroban-auth-entries";
import { buildUnsignedDelegatedGCheckAuthEntry } from "@/lib/delegated-native-auth-entry";
import { canServerSignDelegatedG } from "@/lib/bundler-config";
import {
  discoverContextRule,
  hasMatchedCallContractRule,
  type ContextRuleDiscovery,
} from "@/lib/soroban-context-rules";
import { ApiRequestError } from "@/lib/api-errors";
import type { SignerType } from "@/lib/soroban-transaction-build";
import { stripInvokeAuthEntries } from "@/lib/transaction/validateExternalTx";

export type SimulateAndExtractAuthParams = {
  server: rpc.Server;
  networkPassphrase: string;
  tx: Transaction;
  smartAccountAddress: string;
  targetContractId: string;
  /** When set, skips on-chain context-rule discovery. */
  contextRuleId?: number;
  contextRuleDiscovery?: ContextRuleDiscovery;
  signerType?: SignerType;
  signerG?: string | null;
  /** Bundler G for envelope fee payer / optional delegated __check_auth synthesis. */
  feePayerG?: string | null;
  /** On-chain Delegated G for smart-account AuthPayload (may differ from fee payer). */
  delegatedAuthG?: string | null;
  /** Smart-account rule uses Delegated(bundler) only — prefill + server-side submit. */
  bundlerDelegatedAuthMode?: boolean;
  authEntryLedgerTtl?: number;
  requireMatchedContextRule?: boolean;
};

export type SimulateAndExtractAuthResult = {
  txXdr: string;
  authEntryXdr: string;
  authEntriesXdr: string[];
  smartAccountAuthEntryIndex: number;
  delegatedNativeAuthEntryIndices: number[];
  delegatedNativeSignBlobPayloadsBase64: string[];
  delegatedGAuthEntrySynthesized: boolean;
  contextRuleId: number;
  contextRuleIds: number[];
  contextRuleDiscovery: ContextRuleDiscovery;
  authDigestHex: string;
  signaturePayloadHex: string;
  validUntilLedger: number;
  simulationResultXdr: string;
  latestLedger: number;
  minResourceFee: string;
  smartAccountAuthEntryXdr?: string;
  gAddressPreimageXdr?: string;
  gAddressEntryTemplateXdr?: string;
};

export function serializeSimulationData(
  simResult: rpc.Api.SimulateTransactionSuccessResponse
): string {
  let transactionDataXdr: string | undefined;
  const txData = simResult.transactionData as unknown;

  if (typeof txData === "string") {
    transactionDataXdr = txData;
  } else if (txData && typeof (txData as { toXDR?: unknown }).toXDR === "function") {
    transactionDataXdr = (txData as { toXDR: (format: string) => string }).toXDR("base64");
  } else if (txData && typeof (txData as { build?: unknown }).build === "function") {
    const built = (txData as { build: () => { toXDR: (format: string) => string } }).build();
    transactionDataXdr = built.toXDR("base64");
  }

  return JSON.stringify({
    transactionData: transactionDataXdr,
    minResourceFee: simResult.minResourceFee,
    latestLedger: simResult.latestLedger,
  });
}

function buildDelegatedAuthPayload(gAddress: string, contextRuleIds: number[]): xdr.ScVal {
  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    new Address(gAddress).toScVal(),
  ]);

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signerKey,
          val: xdr.ScVal.scvBytes(Buffer.alloc(0)),
        }),
      ]),
    }),
  ]);
}

function resolveSignerG(
  signerType: SignerType | undefined,
  signerG: string | null | undefined,
  _feePayerG: string | null | undefined
): string | null {
  if (signerType === "freighter" && typeof signerG === "string" && signerG.startsWith("G")) {
    return signerG;
  }
  return null;
}

function buildDelegatedGAddressSigningTemplates(args: {
  smartAccountAddress: string;
  signerG: string;
  authDigest: Buffer;
  validUntilLedger: number;
  networkPassphrase: string;
  contextRuleId: number;
}): {
  gAddressPreimageXdr: string;
  gAddressEntryTemplateXdr: string;
} {
  const { smartAccountAddress, signerG, authDigest, validUntilLedger, networkPassphrase } =
    args;

  const nonceBytes = crypto.randomBytes(8);
  const nonce = nonceBytes.readBigInt64BE(0) as unknown as xdr.Int64;

  const gAddrInvocation = new xdr.SorobanAuthorizedInvocation({
    function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
      new xdr.InvokeContractArgs({
        contractAddress: new Address(smartAccountAddress).toScAddress(),
        functionName: "__check_auth",
        args: [xdr.ScVal.scvBytes(authDigest)],
      })
    ),
    subInvocations: [],
  });

  const networkId = hash(Buffer.from(networkPassphrase));
  const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId,
      nonce,
      signatureExpirationLedger: validUntilLedger,
      invocation: gAddrInvocation,
    })
  );

  const gAddrEntry = new xdr.SorobanAuthorizationEntry({
    credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
      new xdr.SorobanAddressCredentials({
        address: new Address(signerG).toScAddress(),
        nonce,
        signatureExpirationLedger: validUntilLedger,
        signature: xdr.ScVal.scvVoid(),
      })
    ),
    rootInvocation: gAddrInvocation,
  });

  return {
    gAddressPreimageXdr: preimage.toXDR("base64"),
    gAddressEntryTemplateXdr: gAddrEntry.toXDR("base64"),
  };
}

export async function simulateAndExtractAuth(
  params: SimulateAndExtractAuthParams
): Promise<SimulateAndExtractAuthResult> {
  const {
    server,
    networkPassphrase,
    tx,
    smartAccountAddress,
    targetContractId,
    signerType,
    signerG,
    feePayerG,
    authEntryLedgerTtl = 60,
    requireMatchedContextRule = false,
    bundlerDelegatedAuthMode = false,
    delegatedAuthG,
  } = params;

  let contextRuleId = params.contextRuleId;
  let contextRuleDiscovery = params.contextRuleDiscovery;

  if (contextRuleId === undefined || contextRuleDiscovery === undefined) {
    const discovered = await discoverContextRule(
      server,
      networkPassphrase,
      smartAccountAddress,
      targetContractId
    );
    contextRuleId = discovered.contextRuleId;
    contextRuleDiscovery = discovered.discovery;
  }

  if (requireMatchedContextRule && !hasMatchedCallContractRule(contextRuleDiscovery)) {
    throw new ApiRequestError(
      "NO_CONTEXT_RULE",
      `No context rule allows CallContract(${targetContractId}). Run setup-send-rules or setup-swap-rules first.`,
      409
    );
  }

  const txForSimulation = stripInvokeAuthEntries(tx, networkPassphrase);
  const simResult = await server.simulateTransaction(txForSimulation);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new ApiRequestError(
      "simulation_failed",
      `Simulation failed: ${simResult.error}`,
      400
    );
  }
  if (!rpc.Api.isSimulationSuccess(simResult)) {
    throw new ApiRequestError("simulation_failed", "Simulation did not succeed.", 400);
  }

  const entries = normalizeAuthEntries(simResult.result?.auth);
  if (entries.length === 0) {
    throw new ApiRequestError(
      "simulation_failed",
      "No auth entries in simulation result.",
      400
    );
  }

  const validUntilLedger = setAddressCredentialExpiration(
    entries,
    simResult.latestLedger,
    authEntryLedgerTtl
  );

  const signerGStr = resolveSignerG(signerType, signerG, feePayerG);

  let smartAccountAuthEntryIndex = -1;
  const delegatedNativeAuthEntryIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    const role = classifyAuthEntryRole(entries[i], smartAccountAddress, signerGStr);
    if (role === "smart_account_custom" && smartAccountAuthEntryIndex < 0) {
      smartAccountAuthEntryIndex = i;
    }
    if (role === "delegated_native") delegatedNativeAuthEntryIndices.push(i);
  }

  if (smartAccountAuthEntryIndex < 0) {
    throw new ApiRequestError(
      "account_mismatch",
      `Transaction does not require authorization from ${smartAccountAddress}.`,
      400
    );
  }

  const smartAccountAuthEntry = entries[smartAccountAuthEntryIndex];
  const signaturePayload = hashSorobanAuthPayload(smartAccountAuthEntry, networkPassphrase);
  const contextRuleIds = contextRuleIdsForEntry(smartAccountAuthEntry, contextRuleId);

  let delegatedGAuthEntrySynthesized = false;

  function synthesizeDelegatedGEntry(signerGForEntry: string): void {
    if (entries.some((e) => addressStringFromCredentials(e) === signerGForEntry)) {
      return;
    }
    const authDigest = computeAuthDigest(
      smartAccountAuthEntry,
      networkPassphrase,
      contextRuleIds
    );
    entries.push(
      buildUnsignedDelegatedGCheckAuthEntry({
        smartAccountAddress,
        signerG: signerGForEntry,
        authDigestHash: Buffer.from(authDigest),
        signatureExpirationLedger: validUntilLedger,
      })
    );
    delegatedNativeAuthEntryIndices.push(entries.length - 1);
    delegatedGAuthEntrySynthesized = true;
  }

  if (signerGStr && delegatedNativeAuthEntryIndices.length === 0) {
    synthesizeDelegatedGEntry(signerGStr);
  }

  // Freighter swaps: bundler fee-payer may also need a separate __check_auth entry.
  if (
    signerType === "freighter" &&
    typeof feePayerG === "string" &&
    feePayerG.startsWith("G") &&
    feePayerG !== signerGStr
  ) {
    synthesizeDelegatedGEntry(feePayerG);
  }

  if (process.env.DEBUG_SOROBAN_AUTH === "1") {
    console.log(
      "[DEBUG_SOROBAN_AUTH] simulateAndExtractAuth: authCount=%s smartAccountIndex=%s contextRule=%s discovery=%s",
      entries.length,
      smartAccountAuthEntryIndex,
      contextRuleId,
      contextRuleDiscovery
    );
    entries.forEach((e, i) => {
      console.log(
        "[DEBUG_SOROBAN_AUTH] entry[%s] cred=%s addr=%s root=%s role=%s",
        i,
        credentialSwitchName(e),
        addressStringFromCredentials(e) ?? "(none)",
        rootInvocationSummary(e),
        classifyAuthEntryRole(e, smartAccountAddress, signerGStr)
      );
    });
  }

  const firstInvoke = txForSimulation.operations.find(
    (op): op is Operation.InvokeHostFunction => op.type === "invokeHostFunction"
  );
  if (!firstInvoke) {
    throw new ApiRequestError(
      "unsupported_tx",
      "Transaction has no Soroban invoke operations.",
      400
    );
  }

  const assembledBuilder = assembleTransaction(txForSimulation, simResult);
  assembledBuilder.clearOperations();
  assembledBuilder.addOperation(
    Operation.invokeHostFunction({
      source: firstInvoke.source,
      func: firstInvoke.func,
      auth: entries,
    })
  );
  const assembledTx = assembledBuilder.build();

  const authDigestHex = computeAuthDigestHex(
    smartAccountAuthEntry,
    networkPassphrase,
    contextRuleIds
  );

  const delegatedNativeSignBlobPayloadsBase64 = delegatedNativeAuthEntryIndices.map(
    (idx) =>
      Buffer.from(hashSorobanAuthPayload(entries[idx], networkPassphrase)).toString("base64")
  );

  const base: SimulateAndExtractAuthResult = {
    txXdr: assembledTx.toXDR(),
    authEntryXdr: smartAccountAuthEntry.toXDR("base64"),
    authEntriesXdr: entries.map((e) => e.toXDR("base64")),
    smartAccountAuthEntryIndex,
    delegatedNativeAuthEntryIndices,
    delegatedNativeSignBlobPayloadsBase64,
    delegatedGAuthEntrySynthesized,
    contextRuleId,
    contextRuleIds,
    contextRuleDiscovery,
    authDigestHex,
    signaturePayloadHex: signaturePayload.toString("hex"),
    validUntilLedger,
    simulationResultXdr: serializeSimulationData(simResult),
    latestLedger: simResult.latestLedger,
    minResourceFee: simResult.minResourceFee ?? "0",
  };

  if (bundlerDelegatedAuthMode) {
    const authG = delegatedAuthG ?? feePayerG;
    if (!authG) {
      throw new ApiRequestError(
        "validation_error",
        "delegatedAuthG or feePayerG is required for bundler delegated auth mode.",
        400
      );
    }

    const smartAccountCreds = smartAccountAuthEntry.credentials().address();
    smartAccountCreds.signature(buildDelegatedAuthPayload(authG, contextRuleIds));
    synthesizeDelegatedGEntry(authG);

    base.authEntryXdr = smartAccountAuthEntry.toXDR("base64");
    base.authEntriesXdr = entries.map((e) => e.toXDR("base64"));
    base.smartAccountAuthEntryXdr = smartAccountAuthEntry.toXDR("base64");
    base.delegatedGAuthEntrySynthesized = delegatedGAuthEntrySynthesized;
    base.delegatedNativeAuthEntryIndices = [...delegatedNativeAuthEntryIndices];

    if (!canServerSignDelegatedG(authG)) {
      const authDigest = computeAuthDigest(
        smartAccountAuthEntry,
        networkPassphrase,
        contextRuleIds
      );
      const templates = buildDelegatedGAddressSigningTemplates({
        smartAccountAddress,
        signerG: authG,
        authDigest: Buffer.from(authDigest),
        validUntilLedger,
        networkPassphrase,
        contextRuleId,
      });
      base.gAddressPreimageXdr = templates.gAddressPreimageXdr;
      base.gAddressEntryTemplateXdr = templates.gAddressEntryTemplateXdr;
    }

    return base;
  }

  if (signerType === "freighter" && signerGStr) {
    const smartAccountCreds = smartAccountAuthEntry.credentials().address();
    const authDigest = computeAuthDigest(
      smartAccountAuthEntry,
      networkPassphrase,
      contextRuleIds
    );
    const authPayload = buildDelegatedAuthPayload(signerGStr, contextRuleIds);
    smartAccountCreds.signature(authPayload);

    const templates = buildDelegatedGAddressSigningTemplates({
      smartAccountAddress,
      signerG: signerGStr,
      authDigest: Buffer.from(authDigest),
      validUntilLedger,
      networkPassphrase,
      contextRuleId,
    });
    base.smartAccountAuthEntryXdr = smartAccountAuthEntry.toXDR("base64");
    base.gAddressPreimageXdr = templates.gAddressPreimageXdr;
    base.gAddressEntryTemplateXdr = templates.gAddressEntryTemplateXdr;
  }

  return base;
}
