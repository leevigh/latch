import * as crypto from "crypto";
import {
  Address,
  Contract,
  Keypair,
  Operation,
  rpc,
  TransactionBuilder,
  xdr,
  hash,
  nativeToScVal,
} from "@stellar/stellar-sdk";
import { assembleTransaction } from "@stellar/stellar-sdk/rpc";
import {
  computeAuthDigest,
  computeAuthDigestHex,
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
import { getBundlerAccount } from "@/lib/soroban-bundler";
import {
  discoverContextRule,
  hasMatchedCallContractRule,
  type ContextRuleDiscovery,
} from "@/lib/soroban-context-rules";

export type SignerType = "passkey" | "phantom" | "freighter";

export type BuildAuthTransactionParams = {
  server: rpc.Server;
  networkPassphrase: string;
  bundlerKeypair: Keypair;
  smartAccountAddress: string;
  /** Used for context-rule discovery (CallContract target). */
  targetContractId: string;
  buildOperation?: (contract: Contract) => Operation;
  /** When set, invokes `contract` at smartAccountAddress with these ops (e.g. add_context_rule). */
  buildOperationsOnSmartAccount?: (
    smartAccount: Contract
  ) => Operation[];
  signerType: SignerType;
  signerG?: string | null;
  requireMatchedContextRule?: boolean;
};

export type BuildAuthTransactionResult = {
  txXdr: string;
  authEntryXdr: string;
  authEntriesXdr: string[];
  smartAccountAuthEntryIndex: number;
  delegatedNativeAuthEntryIndices: number[];
  delegatedNativeSignBlobPayloadsBase64: string[];
  delegatedGAuthEntrySynthesized: boolean;
  contextRuleId: number;
  contextRuleDiscovery: ContextRuleDiscovery;
  authDigestHex: string;
  signaturePayloadHex: string;
  validUntilLedger: number;
  simulationResultXdr: string;
  /** Freighter delegated path */
  smartAccountAuthEntryXdr?: string;
  gAddressPreimageXdr?: string;
  gAddressEntryTemplateXdr?: string;
};

function serializeTransactionData(simResult: rpc.Api.SimulateTransactionSuccessResponse): string {
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

function buildDelegatedAuthPayload(gAddress: string, contextRuleId: number): xdr.ScVal {
  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    new Address(gAddress).toScVal(),
  ]);

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(contextRuleId)]),
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

export async function buildAuthTransaction(
  params: BuildAuthTransactionParams
): Promise<BuildAuthTransactionResult> {
  const {
    server,
    networkPassphrase,
    bundlerKeypair,
    smartAccountAddress,
    targetContractId,
    buildOperation,
    buildOperationsOnSmartAccount,
    signerType,
    signerG,
    requireMatchedContextRule = false,
  } = params;

  if (!buildOperation && !buildOperationsOnSmartAccount) {
    throw new Error("buildOperation or buildOperationsOnSmartAccount is required");
  }

  const { contextRuleId, discovery: contextRuleDiscovery } = await discoverContextRule(
    server,
    networkPassphrase,
    smartAccountAddress,
    targetContractId
  );

  if (requireMatchedContextRule && !hasMatchedCallContractRule(contextRuleDiscovery)) {
    const err = new Error(
      `No context rule allows CallContract(${targetContractId}). Run setup-send-rules first.`
    ) as Error & { code?: string };
    err.code = "NO_CONTEXT_RULE";
    throw err;
  }

  const account = await getBundlerAccount(server, bundlerKeypair);

  const txBuilder = new TransactionBuilder(account, {
    fee: "1000000",
    networkPassphrase,
  }).setTimeout(300);

  if (buildOperationsOnSmartAccount) {
    const smartAccount = new Contract(smartAccountAddress);
    for (const op of buildOperationsOnSmartAccount(smartAccount)) {
      txBuilder.addOperation(op as Operation);
    }
  } else if (buildOperation) {
    const contract = new Contract(targetContractId);
    txBuilder.addOperation(buildOperation(contract) as Operation);
  }

  const tx = txBuilder.build();

  const simResult = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }
  if (!rpc.Api.isSimulationSuccess(simResult)) {
    throw new Error("Simulation did not succeed");
  }

  const entries = normalizeAuthEntries(simResult.result?.auth);
  if (entries.length === 0) {
    throw new Error("No auth entries in simulation result");
  }

  const validUntilLedger = setAddressCredentialExpiration(
    entries,
    simResult.latestLedger,
    60
  );

  const signerGStr =
    signerType === "freighter" && typeof signerG === "string" && signerG.startsWith("G")
      ? signerG
      : typeof signerG === "string" && signerG.startsWith("G")
        ? signerG
        : null;

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
    throw new Error(
      "No SorobanAuthorizationEntry matches smartAccountAddress credentials; cannot build auth digest."
    );
  }

  const smartAccountAuthEntry = entries[smartAccountAuthEntryIndex];
  const signaturePayload = hashSorobanAuthPayload(smartAccountAuthEntry, networkPassphrase);

  let delegatedGAuthEntrySynthesized = false;
  if (signerGStr && delegatedNativeAuthEntryIndices.length === 0) {
    entries.push(
      buildUnsignedDelegatedGCheckAuthEntry({
        smartAccountAddress,
        signerG: signerGStr,
        authPayloadHash: Buffer.from(signaturePayload),
        signatureExpirationLedger: validUntilLedger,
      })
    );
    delegatedNativeAuthEntryIndices.push(entries.length - 1);
    delegatedGAuthEntrySynthesized = true;
  }

  if (process.env.DEBUG_SOROBAN_AUTH === "1") {
    console.log(
      "[DEBUG_SOROBAN_AUTH] buildAuthTransaction: authCount=%s smartAccountIndex=%s contextRule=%s discovery=%s",
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

  const assembledBuilder = assembleTransaction(tx, simResult);
  assembledBuilder.clearOperations();
  const origOp = tx.operations[0] as Operation.InvokeHostFunction;
  assembledBuilder.addOperation(
    Operation.invokeHostFunction({
      source: origOp.source,
      func: origOp.func,
      auth: entries,
    })
  );
  const assembledTx = assembledBuilder.build();

  const contextRuleIds = [contextRuleId];
  const authDigestHex = computeAuthDigestHex(
    smartAccountAuthEntry,
    networkPassphrase,
    contextRuleIds
  );

  const delegatedNativeSignBlobPayloadsBase64 = delegatedNativeAuthEntryIndices.map(
    (idx) =>
      Buffer.from(
        hashSorobanAuthPayload(entries[idx], networkPassphrase)
      ).toString("base64")
  );

  const base: BuildAuthTransactionResult = {
    txXdr: assembledTx.toXDR(),
    authEntryXdr: smartAccountAuthEntry.toXDR("base64"),
    authEntriesXdr: entries.map((e) => e.toXDR("base64")),
    smartAccountAuthEntryIndex,
    delegatedNativeAuthEntryIndices,
    delegatedNativeSignBlobPayloadsBase64,
    delegatedGAuthEntrySynthesized,
    contextRuleId,
    contextRuleDiscovery,
    authDigestHex,
    signaturePayloadHex: signaturePayload.toString("hex"),
    validUntilLedger,
    simulationResultXdr: serializeTransactionData(simResult),
  };

  if (signerType === "freighter" && signerGStr) {
    const smartAccountCreds = smartAccountAuthEntry.credentials().address();
    const authDigest = computeAuthDigest(
      smartAccountAuthEntry,
      networkPassphrase,
      contextRuleIds
    );
    const authPayload = buildDelegatedAuthPayload(signerGStr, contextRuleId);
    smartAccountCreds.signature(authPayload);

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
          address: new Address(signerGStr).toScAddress(),
          nonce,
          signatureExpirationLedger: validUntilLedger,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: gAddrInvocation,
    });

    base.smartAccountAuthEntryXdr = smartAccountAuthEntry.toXDR("base64");
    base.gAddressPreimageXdr = preimage.toXDR("base64");
    base.gAddressEntryTemplateXdr = gAddrEntry.toXDR("base64");
  }

  return base;
}

/** SAC token transfer: transfer(from, to, amount). */
export function buildSacTransferOperation(
  tokenContractId: string,
  fromAddress: string,
  toAddress: string,
  amountI128: bigint
): (contract: Contract) => Operation {
  return (contract: Contract) =>
    contract.call(
      "transfer",
      new Address(fromAddress).toScVal(),
      new Address(toAddress).toScVal(),
      nativeToScVal(amountI128, { type: "i128" })
    ) as Operation;
}
