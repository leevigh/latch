import { xdr } from "@stellar/stellar-sdk";
import {
  addressStringFromCredentials,
  isUnsignedAddressAuthEntry,
} from "@/lib/soroban-auth-entries";
import {
  applyDelegatedFreighterSignature,
  authDigestHexFromSmartAccountEntry,
  delegatedCheckAuthArgHex,
} from "@/lib/delegated-check-auth-entry";
import { buildMultisigAuthPayload, type WebauthnApprovalInput } from "@/lib/multisig";

export type ApprovalRow = {
  approvalType: string;
  webauthnSigDataXdrHex: string | null;
  delegatedEntryTemplateXdr: string | null;
  delegatedSignedAuthEntryBase64: string | null;
  delegatedSignerAddress: string | null;
  member: { memberType: string; keyDataHex: string | null; gAddress: string | null };
};

/** Use exactly `threshold` complete approvals (webauthn first, then delegated). */
export function pickApprovalsForThreshold(
  threshold: number,
  webauthn: ApprovalRow[],
  delegated: ApprovalRow[]
): { webauthn: ApprovalRow[]; delegated: ApprovalRow[] } {
  const webauthnUsed = webauthn.slice(0, threshold);
  const remaining = Math.max(0, threshold - webauthnUsed.length);
  const delegatedUsed = delegated.slice(0, remaining);
  return { webauthn: webauthnUsed, delegated: delegatedUsed };
}

export function signedDelegatedEntryFromApproval(
  approval: ApprovalRow
): xdr.SorobanAuthorizationEntry {
  if (
    !approval.delegatedEntryTemplateXdr ||
    !approval.delegatedSignedAuthEntryBase64 ||
    !approval.delegatedSignerAddress
  ) {
    throw new Error("Delegated approval is missing signature material");
  }
  return applyDelegatedFreighterSignature(
    approval.delegatedEntryTemplateXdr,
    approval.delegatedSignedAuthEntryBase64,
    approval.delegatedSignerAddress
  );
}

/**
 * Final auth entry list for submit: smart-account row + signed delegated rows only.
 * Avoids duplicating void delegated placeholders from the original simulation.
 */
export function buildMultisigExecuteAuthEntries(args: {
  entries: xdr.SorobanAuthorizationEntry[];
  smartAccountAuthEntryIndex: number;
  contextRuleId: number;
  networkPassphrase: string;
  webauthnVerifierAddress: string;
  webauthnApprovals: ApprovalRow[];
  delegatedApprovals: ApprovalRow[];
}): xdr.SorobanAuthorizationEntry[] {
  const {
    entries,
    smartAccountAuthEntryIndex,
    contextRuleId,
    networkPassphrase,
    webauthnVerifierAddress,
    webauthnApprovals,
    delegatedApprovals,
  } = args;

  if (smartAccountAuthEntryIndex < 0 || smartAccountAuthEntryIndex >= entries.length) {
    throw new Error("Invalid smartAccountAuthEntryIndex");
  }

  const smartAccountEntry = entries[smartAccountAuthEntryIndex];
  const liveAuthDigestHex = authDigestHexFromSmartAccountEntry(
    smartAccountEntry,
    networkPassphrase,
    [contextRuleId]
  );

  for (const approval of delegatedApprovals) {
    if (!approval.delegatedEntryTemplateXdr) continue;
    const template = xdr.SorobanAuthorizationEntry.fromXDR(
      approval.delegatedEntryTemplateXdr,
      "base64"
    );
    const templateArgHex = delegatedCheckAuthArgHex(template);
    if (!templateArgHex || templateArgHex !== liveAuthDigestHex) {
      throw new Error(
        "Delegated Freighter approval is out of date for this proposal. Re-approve with Freighter, then execute again."
      );
    }
  }

  const webauthnInputs: WebauthnApprovalInput[] = webauthnApprovals.map((a) => ({
    verifierAddress: webauthnVerifierAddress,
    keyDataHex: a.member.keyDataHex!,
    sigDataXdrHex: a.webauthnSigDataXdrHex!,
  }));

  const authPayload = buildMultisigAuthPayload({
    contextRuleId,
    webauthn: webauthnInputs,
    delegated: delegatedApprovals.map((a) => ({ gAddress: a.member.gAddress! })),
  });

  smartAccountEntry.credentials().address().signature(authPayload);

  const result: xdr.SorobanAuthorizationEntry[] = [smartAccountEntry];

  // Keep non-smart-account entries that simulation already signed. Drop unsigned
  // address-credential stubs (common for SAC transfers with multiple delegated signers).
  for (let i = 0; i < entries.length; i++) {
    if (i === smartAccountAuthEntryIndex) continue;
    const entry = entries[i];
    const addr = addressStringFromCredentials(entry);
    if (addr && isUnsignedAddressAuthEntry(entry)) continue;
    result.push(entry);
  }

  for (const approval of delegatedApprovals) {
    result.push(signedDelegatedEntryFromApproval(approval));
  }

  return result;
}
