import { rpc } from "@stellar/stellar-sdk";
import type { Network } from "@/lib/network";
import { resolveNetwork } from "@/lib/network";
import { ApiRequestError } from "@/lib/api-errors";
import { isSwapRouterContractId } from "@/lib/swap-routers";
import {
  discoverContextRule,
  discoverDefaultContextRule,
  fetchContextRuleAtId,
  hasMatchedCallContractRule,
  type ContextRuleDiscovery,
} from "@/lib/soroban-context-rules";
import {
  resolveBundlerFeePayerG,
} from "@/lib/bundler-config";
import type { SignerType } from "@/lib/soroban-transaction-build";
import { simulateAndExtractAuth } from "@/lib/transaction/simulateAndExtractAuth";
import {
  validateContextRuleForSignerType,
  assertSwapRuleReadyForSign,
  resolveSwapAuthMode,
} from "@/lib/transaction/validateContextRuleSigners";
import { estimateFees } from "@/lib/transaction/estimateFees";
import {
  buildReviewWarnings,
  parseOperationsForReview,
  type PreparedSignOperation,
} from "@/lib/transaction/parseOperationsForReview";
import {
  extractTargetContractId,
  isSmartAccountSelfInvoke,
  parseExternalTransaction,
  preValidateSmartAccountBinding,
} from "@/lib/transaction/validateExternalTx";

export type PrepareSignRequest = {
  network: Network;
  smartAccountAddress: string;
  unsignedTxXdr: string;
  signerType?: SignerType;
  signerG?: string;
  /** Bundler public G when tx source is bundler; used for delegated entry synthesis only. */
  feePayerG?: string;
  /** When known (e.g. from build-swap), skips on-chain rule scan in prepare-sign. */
  contextRuleId?: number;
  contextRuleDiscovery?: ContextRuleDiscovery;
};

export type PrepareSignResponse = {
  network: Network;
  smartAccountAddress: string;
  txXdr: string;
  authEntryXdr: string;
  authEntriesXdr: string[];
  smartAccountAuthEntryIndex: number;
  delegatedNativeAuthEntryIndices: number[];
  delegatedGAuthEntrySynthesized: boolean;
  contextRuleId: number;
  contextRuleIds: number[];
  authDigestHex: string;
  signaturePayloadHex: string;
  validUntilLedger: number;
  simulationResultXdr: string;
  smartAccountAuthEntryXdr?: string;
  gAddressPreimageXdr?: string;
  gAddressEntryTemplateXdr?: string;
  estimatedFeeXlm: string;
  estimatedFeeUsd?: string;
  feeLabel: string;
  operations: PreparedSignOperation[];
  warnings: string[];
  submitMethod?: "bundler-delegated" | "delegated" | "webauthn";
};

export async function prepareExternalSign(
  req: PrepareSignRequest
): Promise<PrepareSignResponse> {
  const { networkPassphrase, rpcUrl } = resolveNetwork(req.network);
  const server = new rpc.Server(rpcUrl);

  const tx = parseExternalTransaction(req.unsignedTxXdr, networkPassphrase);
  preValidateSmartAccountBinding(tx, req.smartAccountAddress);

  const targetContractId = extractTargetContractId(tx);
  if (!targetContractId) {
    throw new ApiRequestError(
      "unsupported_tx",
      "Could not determine target contract from transaction operations."
    );
  }

  const feePayerG = resolveBundlerFeePayerG(req.feePayerG);
  const isSwap = isSwapRouterContractId(targetContractId);
  /** Admin / setup txs invoke the smart account (e.g. add_context_rule) under Default. */
  const isAdminSelfInvoke = isSmartAccountSelfInvoke(
    targetContractId,
    req.smartAccountAddress
  );

  let contextRuleId = req.contextRuleId;
  let discovery = req.contextRuleDiscovery;

  if (contextRuleId === undefined || discovery === undefined) {
    if (isSwap || isAdminSelfInvoke) {
      const discovered = await discoverDefaultContextRule(
        server,
        networkPassphrase,
        req.smartAccountAddress
      );
      contextRuleId = discovered.contextRuleId;
      discovery = discovered.discovery;
    } else {
      const discovered = await discoverContextRule(
        server,
        networkPassphrase,
        req.smartAccountAddress,
        targetContractId
      );
      contextRuleId = discovered.contextRuleId;
      discovery = discovered.discovery;
    }
  }
  const swapRule = await fetchContextRuleAtId(
    server,
    networkPassphrase,
    req.smartAccountAddress,
    contextRuleId
  );

  if (isSwap) {
    const swapAuthPreview = resolveSwapAuthMode({
      rule: swapRule,
      signerType: req.signerType ?? "passkey",
      signerG: req.signerG,
    });
    if (swapAuthPreview.needsPasskeySetup) {
      assertSwapRuleReadyForSign({ rule: swapRule, contextRuleId });
    }
  } else if (hasMatchedCallContractRule(discovery)) {
    assertSwapRuleReadyForSign({ rule: swapRule, contextRuleId });
  }

  const swapAuth = isSwap
    ? resolveSwapAuthMode({
        rule: swapRule,
        signerType: req.signerType ?? "passkey",
        signerG: req.signerG,
      })
    : { useDelegatedAuth: false, needsPasskeySetup: false };

  const auth = await simulateAndExtractAuth({
    server,
    networkPassphrase,
    tx,
    smartAccountAddress: req.smartAccountAddress,
    targetContractId,
    contextRuleId,
    contextRuleDiscovery: discovery,
    signerType: req.signerType,
    signerG: swapAuth.useDelegatedAuth ? swapAuth.delegatedAuthG : req.signerG,
    feePayerG,
    // SAC/transfer requires CallContract(target); swap + admin self-invoke use Default.
    requireMatchedContextRule: !isSwap && !isAdminSelfInvoke,
    bundlerDelegatedAuthMode: swapAuth.useDelegatedAuth,
    delegatedAuthG: swapAuth.delegatedAuthG,
  });

  if (req.signerType && feePayerG && !swapAuth.useDelegatedAuth) {
    await validateContextRuleForSignerType({
      server,
      networkPassphrase,
      smartAccountAddress: req.smartAccountAddress,
      contextRuleId: auth.contextRuleId,
      signerType: req.signerType,
      signerG: req.signerG,
      feePayerG,
      bundlerPublicKey: feePayerG,
    });
  }

  const feeEstimate = estimateFees(
    {
      minResourceFee: auth.minResourceFee,
      latestLedger: auth.latestLedger,
    } as rpc.Api.SimulateTransactionSuccessResponse,
    tx.fee
  );

  const operations = parseOperationsForReview(tx, networkPassphrase);
  const warnings = buildReviewWarnings({
    validUntilLedger: auth.validUntilLedger,
    latestLedger: auth.latestLedger,
    tx,
    networkPassphrase,
  });

  return {
    network: req.network,
    smartAccountAddress: req.smartAccountAddress,
    txXdr: auth.txXdr,
    authEntryXdr: auth.authEntryXdr,
    authEntriesXdr: auth.authEntriesXdr,
    smartAccountAuthEntryIndex: auth.smartAccountAuthEntryIndex,
    delegatedNativeAuthEntryIndices: auth.delegatedNativeAuthEntryIndices,
    delegatedGAuthEntrySynthesized: auth.delegatedGAuthEntrySynthesized,
    contextRuleId: auth.contextRuleId,
    contextRuleIds: auth.contextRuleIds,
    authDigestHex: auth.authDigestHex,
    signaturePayloadHex: auth.signaturePayloadHex,
    validUntilLedger: auth.validUntilLedger,
    simulationResultXdr: auth.simulationResultXdr,
    smartAccountAuthEntryXdr: auth.smartAccountAuthEntryXdr,
    gAddressPreimageXdr: auth.gAddressPreimageXdr,
    gAddressEntryTemplateXdr: auth.gAddressEntryTemplateXdr,
    estimatedFeeXlm: feeEstimate.estimatedFeeXlm,
    feeLabel: feeEstimate.feeLabel,
    operations,
    warnings,
    submitMethod: swapAuth.useDelegatedAuth
      ? "bundler-delegated"
      : req.signerType === "freighter"
        ? "delegated"
        : req.signerType === "passkey" || req.signerType === "phantom"
          ? "webauthn"
          : undefined,
  };
}
