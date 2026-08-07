import { Keypair } from "@stellar/stellar-sdk";
import { ApiRequestError } from "@/lib/api-errors";
import {
  ruleHasExternalSigner,
  type ContextRuleSummary,
} from "@/lib/soroban-context-rules";

export function getBundlerKeypair(): Keypair {
  const secret = process.env.BUNDLER_SECRET;
  if (!secret) {
    throw new ApiRequestError("internal_error", "BUNDLER_SECRET is not set.", 500);
  }
  return Keypair.fromSecret(secret);
}

export function getBundlerPublicKey(): string {
  return getBundlerKeypair().publicKey();
}

/** Optional secret for an older on-chain Delegated signer (e.g. before bundler rotation). */
export function getLegacyDelegatedSignerKeypair(): Keypair | null {
  const secret =
    process.env.LEGACY_DELEGATED_SIGNER_SECRET?.trim() ||
    process.env.LEGACY_BUNDLER_SECRET?.trim();
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret);
  } catch {
    return null;
  }
}

/** Keypair that can sign a delegated G-address auth entry, if configured on the server. */
export function resolveSignerKeypairForG(gAddress: string): Keypair | null {
  const bundler = getBundlerKeypair();
  if (bundler.publicKey() === gAddress) return bundler;
  const legacy = getLegacyDelegatedSignerKeypair();
  if (legacy?.publicKey() === gAddress) return legacy;
  return null;
}

export function canServerSignDelegatedG(gAddress: string): boolean {
  return resolveSignerKeypairForG(gAddress) !== null;
}

/** Delegated G on a context rule, if the rule is bundler-only delegated. */
export function delegatedGFromContextRule(rule: ContextRuleSummary): string | null {
  const delegated = rule.signers.filter((s) => s.kind === "Delegated");
  if (delegated.length !== 1 || rule.signers.some((s) => s.kind === "External")) {
    return null;
  }
  return delegated[0].gAddress ?? null;
}

/** Rule authorizes a single Delegated G that is not the API's current fee-payer. */
export function isStaleDelegatedBundlerRule(
  rule: ContextRuleSummary | null,
  bundlerPublicKey?: string
): boolean {
  if (!rule) return false;
  const ruleG = delegatedGFromContextRule(rule);
  if (!ruleG) return false;
  const bundlerG = bundlerPublicKey ?? getBundlerPublicKey();
  return ruleG !== bundlerG;
}

/**
 * Context rules were created with a different fee-payer G (e.g. extension default).
 * The API always uses BUNDLER_SECRET; re-run setup to update on-chain signers.
 */
export function assertContextRuleBundlerCurrent(args: {
  rule: ContextRuleSummary | null;
  contextRuleId: number;
  context: string;
}): void {
  const { rule, contextRuleId } = args;
  if (!isStaleDelegatedBundlerRule(rule)) return;

  const ruleG = delegatedGFromContextRule(rule!)!;
  const bundlerG = getBundlerPublicKey();

  throw new ApiRequestError(
    "SIGNER_MISMATCH",
    `Context rule ${contextRuleId} still authorizes Delegated(${ruleG}) from an older setup. ` +
      `This API uses fee-payer ${bundlerG} (BUNDLER_SECRET). Confirm the swap again to reconfigure the on-chain rule for your passkey.`,
    409
  );
}

/** Always use BUNDLER_SECRET public key; ignore stale feePayerG from the extension. */
export function resolveBundlerFeePayerG(_feePayerGFromClient?: string): string {
  return getBundlerPublicKey();
}

export function assertAuthPayloadBundlerMatchesServer(delegatedG: string): void {
  if (canServerSignDelegatedG(delegatedG)) return;

  const bundlerG = getBundlerPublicKey();
  throw new ApiRequestError(
    "SIGNER_MISMATCH",
    `Transaction auth expects Delegated(${delegatedG}) but this API cannot sign it (fee-payer is ${bundlerG}). ` +
      `Sign the delegated auth entry client-side with ${delegatedG}, or set LEGACY_DELEGATED_SIGNER_SECRET.`,
    409
  );
}

export function ruleNeedsPasskeyReconfigure(rule: ContextRuleSummary | null): boolean {
  if (!rule) return false;
  if (ruleHasExternalSigner(rule)) return false;
  return delegatedGFromContextRule(rule) !== null;
}
