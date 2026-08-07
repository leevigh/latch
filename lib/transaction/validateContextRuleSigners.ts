import { rpc } from "@stellar/stellar-sdk";
import { ApiRequestError } from "@/lib/api-errors";
import { delegatedGFromContextRule } from "@/lib/bundler-config";
import {
  getContextRule,
  ruleHasExternalSigner,
  ruleHasOnlyDelegatedG,
  type ContextRuleSummary,
} from "@/lib/soroban-context-rules";
import type { SignerType } from "@/lib/soroban-transaction-build";

/** Rule authorizes only Delegated(G) signers — passkey setup required before swap. */
export function ruleIsDelegatedOnly(rule: ContextRuleSummary | null): boolean {
  if (!rule || rule.signers.length === 0) return false;
  if (ruleHasExternalSigner(rule)) return false;
  return rule.signers.every((s) => s.kind === "Delegated");
}

/** Delegated-only default rule: swaps can authorize via the on-chain Delegated(G). */
export function isDelegatedOnlyRule(rule: ContextRuleSummary | null): boolean {
  return ruleIsDelegatedOnly(rule);
}

export type SwapAuthResolution = {
  /** Smart-account auth uses Delegated(ruleG), not External passkey. */
  useDelegatedAuth: boolean;
  delegatedAuthG?: string;
  /** Passkey/phantom requested but rule only has Delegated — run setup-swap-rules first. */
  needsPasskeySetup: boolean;
};

export function resolveSwapAuthMode(args: {
  rule: ContextRuleSummary | null;
  signerType: SignerType;
  signerG?: string | null;
}): SwapAuthResolution {
  const { rule, signerType, signerG } = args;
  if (!ruleIsDelegatedOnly(rule)) {
    return { useDelegatedAuth: false, needsPasskeySetup: false };
  }

  const ruleG = rule ? delegatedGFromContextRule(rule) : null;
  if (!ruleG) {
    return { useDelegatedAuth: false, needsPasskeySetup: false };
  }

  if (signerType === "freighter" && signerG === ruleG) {
    return { useDelegatedAuth: true, delegatedAuthG: ruleG, needsPasskeySetup: false };
  }

  if (signerType === "passkey" || signerType === "phantom") {
    return { useDelegatedAuth: false, needsPasskeySetup: true };
  }

  return { useDelegatedAuth: false, needsPasskeySetup: false };
}

export function assertSwapRuleReadyForSign(args: {
  rule: ContextRuleSummary | null;
  contextRuleId: number;
}): void {
  const { rule, contextRuleId } = args;
  if (!ruleIsDelegatedOnly(rule)) return;

  const delegatedG =
    rule!.signers.find((s) => s.kind === "Delegated")?.gAddress ?? "unknown";

  throw new ApiRequestError(
    "SIGNER_MISMATCH",
    `Default context rule ${contextRuleId} only authorizes Delegated(${delegatedG}). ` +
      `Confirm the swap again to run setup-swap-rules (adds your passkey to the default rule), then retry.`,
    409
  );
}

export function ruleAllowsDelegatedG(
  rule: ContextRuleSummary,
  gAddress: string
): boolean {
  return rule.signers.some(
    (s) => s.kind === "Delegated" && s.gAddress === gAddress
  );
}

/** True when an existing on-chain rule matches the signers this setup request would add. */
export function contextRuleSignersMatchSetup(args: {
  rule: ContextRuleSummary;
  signerType: SignerType;
  verifierAddress?: string;
  gAddress?: string;
}): boolean {
  const { rule, signerType, verifierAddress, gAddress } = args;

  if (signerType === "passkey" || signerType === "phantom") {
    if (!ruleHasExternalSigner(rule)) return false;
    if (verifierAddress) {
      return rule.signers.some(
        (s) => s.kind === "External" && s.verifierAddress === verifierAddress
      );
    }
    return true;
  }

  if (signerType === "freighter") {
    return Boolean(gAddress && ruleAllowsDelegatedG(rule, gAddress));
  }

  return false;
}

/**
 * Ensure on-chain context rule signers match the requested login / signing method.
 */
export async function validateContextRuleForSignerType(args: {
  server: rpc.Server;
  networkPassphrase: string;
  smartAccountAddress: string;
  contextRuleId: number;
  signerType: SignerType;
  signerG?: string | null;
  feePayerG?: string | null;
  bundlerPublicKey: string;
}): Promise<void> {
  const { signerType, signerG, feePayerG, bundlerPublicKey } = args;

  if (signerG === bundlerPublicKey) {
    throw new ApiRequestError(
      "validation_error",
      "signerG must be the user's Freighter G-address, not the bundler fee-payer.",
      400
    );
  }

  const rule = await getContextRule(
    args.server,
    args.networkPassphrase,
    args.smartAccountAddress,
    args.contextRuleId
  );
  if (!rule) return;

  if (signerType === "passkey" || signerType === "phantom") {
    if (
      feePayerG &&
      ruleHasOnlyDelegatedG(rule, feePayerG) &&
      !ruleHasExternalSigner(rule)
    ) {
      throw new ApiRequestError(
        "SIGNER_MISMATCH",
        "Swap rule was configured for Delegated G (bundler), but passkey was requested. Remove the rule and run setup-swap-rules again with keyDataHex.",
        409
      );
    }
    if (!ruleHasExternalSigner(rule)) {
      throw new ApiRequestError(
        "SIGNER_MISMATCH",
        "Swap context rule has no External passkey signer yet. Confirm the swap again to run setup-swap-rules (adds your passkey to the existing rule).",
        409
      );
    }
    return;
  }

  if (signerType === "freighter") {
    if (!signerG) {
      throw new ApiRequestError(
        "validation_error",
        "signerG is required for freighter.",
        400
      );
    }
    if (!ruleHasExternalSigner(rule)) {
      throw new ApiRequestError(
        "SIGNER_MISMATCH",
        "Swap context rule has no External passkey signer yet. Confirm the swap again to run setup-swap-rules first.",
        409
      );
    }
    if (ruleHasExternalSigner(rule) && !ruleAllowsDelegatedG(rule, signerG)) {
      throw new ApiRequestError(
        "SIGNER_MISMATCH",
        "Swap rule was configured for passkey (External signer), but Freighter was requested. Remove the rule and run setup-swap-rules with gAddress.",
        409
      );
    }
    if (
      !ruleHasExternalSigner(rule) &&
      !ruleAllowsDelegatedG(rule, signerG) &&
      rule.signers.some((s) => s.kind === "Delegated")
    ) {
      throw new ApiRequestError(
        "SIGNER_MISMATCH",
        `Swap rule Delegated signer does not match signerG (${signerG}). Re-run setup-swap-rules with your Freighter G-address.`,
        409
      );
    }
  }
}
