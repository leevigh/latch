import {
  Address,
  Contract,
  Keypair,
  Operation,
  rpc,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";
import { getBundlerAccount } from "@/lib/soroban-bundler";
import {
  discoverContextRule,
  discoverDefaultContextRule,
  fetchContextRuleAtId,
  hasMatchedCallContractRule,
  ruleHasExternalSigner,
  type ContextRuleDiscovery,
} from "@/lib/soroban-context-rules";
import {
  getBundlerPublicKey,
  canServerSignDelegatedG,
  delegatedGFromContextRule,
} from "@/lib/bundler-config";
import { simulateAndExtractAuth } from "@/lib/transaction/simulateAndExtractAuth";

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
  /** Bundler G used only for delegated __check_auth entry synthesis (passkey + fee-payer txs). */
  feePayerG?: string | null;
  /** On-chain Delegated G for smart-account AuthPayload (setup admin rules). */
  delegatedAuthG?: string | null;
  /** On-chain rule authorizes only Delegated(bundler). */
  bundlerDelegatedAuthMode?: boolean;
  /** Use Default context rule (id 0) — required for DEX swaps (see mobile wallet reference). */
  useDefaultContextRule?: boolean;
  requireMatchedContextRule?: boolean;
  /** Ledgers added to latest ledger for address credential expiration (default 60). */
  authEntryLedgerTtl?: number;
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
  contextRuleIds: number[];
  contextRuleDiscovery: ContextRuleDiscovery;
  authDigestHex: string;
  signaturePayloadHex: string;
  validUntilLedger: number;
  simulationResultXdr: string;
  /** Freighter delegated path */
  smartAccountAuthEntryXdr?: string;
  gAddressPreimageXdr?: string;
  gAddressEntryTemplateXdr?: string;
  submitMethod?: "bundler-delegated" | "delegated" | "webauthn";
  delegatedAuthG?: string;
};

export async function buildUnsignedSorobanTransaction(
  params: Pick<
    BuildAuthTransactionParams,
    | "server"
    | "networkPassphrase"
    | "bundlerKeypair"
    | "smartAccountAddress"
    | "targetContractId"
    | "buildOperation"
    | "buildOperationsOnSmartAccount"
  >
): Promise<Transaction> {
  const {
    server,
    networkPassphrase,
    bundlerKeypair,
    smartAccountAddress,
    targetContractId,
    buildOperation,
    buildOperationsOnSmartAccount,
  } = params;

  if (!buildOperation && !buildOperationsOnSmartAccount) {
    throw new Error("buildOperation or buildOperationsOnSmartAccount is required");
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

  return txBuilder.build();
}

export async function buildAuthTransaction(
  params: BuildAuthTransactionParams
): Promise<BuildAuthTransactionResult> {
  const {
    server,
    networkPassphrase,
    smartAccountAddress,
    targetContractId,
    signerType,
    signerG,
    feePayerG,
    requireMatchedContextRule = false,
    authEntryLedgerTtl = 60,
    bundlerDelegatedAuthMode = false,
    useDefaultContextRule = false,
    delegatedAuthG: delegatedAuthGFromParams,
  } = params;

  const isSetupTx = Boolean(params.buildOperationsOnSmartAccount);

  const { contextRuleId, discovery: contextRuleDiscovery } = isSetupTx || useDefaultContextRule
    ? await discoverDefaultContextRule(server, networkPassphrase, smartAccountAddress)
    : await discoverContextRule(
        server,
        networkPassphrase,
        smartAccountAddress,
        targetContractId
      );

  let useBundlerDelegatedAuth = bundlerDelegatedAuthMode;
  let delegatedAuthG: string | undefined = delegatedAuthGFromParams ?? undefined;
  if (isSetupTx && !useBundlerDelegatedAuth) {
    const adminRule = await fetchContextRuleAtId(
      server,
      networkPassphrase,
      smartAccountAddress,
      contextRuleId
    );
    const ruleG = adminRule ? delegatedGFromContextRule(adminRule) : null;
    if (ruleG && !ruleHasExternalSigner(adminRule!)) {
      useBundlerDelegatedAuth = true;
      delegatedAuthG = ruleG;
    }
  }

  const envelopeFeePayerG = feePayerG ?? getBundlerPublicKey();

  if (requireMatchedContextRule && !hasMatchedCallContractRule(contextRuleDiscovery)) {
    const err = new Error(
      `No context rule allows CallContract(${targetContractId}). Run setup-send-rules or setup-swap-rules first.`
    ) as Error & { code?: string };
    err.code = "NO_CONTEXT_RULE";
    throw err;
  }

  const tx = await buildUnsignedSorobanTransaction(params);

  const auth = await simulateAndExtractAuth({
    server,
    networkPassphrase,
    tx,
    smartAccountAddress,
    targetContractId,
    contextRuleId,
    contextRuleDiscovery,
    signerType,
    signerG,
    feePayerG: envelopeFeePayerG,
    delegatedAuthG,
    authEntryLedgerTtl,
    bundlerDelegatedAuthMode: useBundlerDelegatedAuth,
  });

  const authDelegatedG = delegatedAuthG ?? envelopeFeePayerG;

  return {
    txXdr: auth.txXdr,
    authEntryXdr: auth.authEntryXdr,
    authEntriesXdr: auth.authEntriesXdr,
    smartAccountAuthEntryIndex: auth.smartAccountAuthEntryIndex,
    delegatedNativeAuthEntryIndices: auth.delegatedNativeAuthEntryIndices,
    delegatedNativeSignBlobPayloadsBase64: auth.delegatedNativeSignBlobPayloadsBase64,
    delegatedGAuthEntrySynthesized: auth.delegatedGAuthEntrySynthesized,
    contextRuleId: auth.contextRuleId,
    contextRuleIds: auth.contextRuleIds,
    contextRuleDiscovery: auth.contextRuleDiscovery,
    authDigestHex: auth.authDigestHex,
    signaturePayloadHex: auth.signaturePayloadHex,
    validUntilLedger: auth.validUntilLedger,
    simulationResultXdr: auth.simulationResultXdr,
    smartAccountAuthEntryXdr: auth.smartAccountAuthEntryXdr,
    gAddressPreimageXdr: auth.gAddressPreimageXdr,
    gAddressEntryTemplateXdr: auth.gAddressEntryTemplateXdr,
    submitMethod: useBundlerDelegatedAuth
      ? canServerSignDelegatedG(authDelegatedG)
        ? "bundler-delegated"
        : "delegated"
      : signerType === "freighter"
        ? "delegated"
        : "webauthn",
    delegatedAuthG: useBundlerDelegatedAuth ? authDelegatedG : undefined,
  };
}

/** Aquarius router: swap_chained(user, chain, tokenIn, amountIn, amountOutMin). */
export function buildSwapChainedOperation(
  smartAccountAddress: string,
  swapChainXdr: string,
  tokenInContractId: string,
  amountInRaw: bigint,
  amountOutMinRaw: bigint
): (router: Contract) => Operation {
  const swapChain = xdr.ScVal.fromXDR(swapChainXdr, "base64");
  return (router: Contract) =>
    router.call(
      "swap_chained",
      new Address(smartAccountAddress).toScVal(),
      swapChain,
      new Address(tokenInContractId).toScVal(),
      nativeToScVal(amountInRaw, { type: "u128" }),
      nativeToScVal(amountOutMinRaw, { type: "u128" })
    ) as Operation;
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
