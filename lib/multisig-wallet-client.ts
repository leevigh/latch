import { signAuthEntry } from "@stellar/freighter-api";
import { Networks } from "@stellar/stellar-sdk";
import { encodeWebAuthnSigData, signWithPasskey } from "@/lib/webauthn";
import {
  assertWebAuthnClientAvailable,
  getWebauthnRpIdForCeremony,
} from "@/lib/webauthn-client";

const NETWORK_PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET;

export const DEFAULT_COUNTER_CONTRACT =
  process.env.NEXT_PUBLIC_COUNTER_ADDRESS ||
  "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U";

export class MultisigApiError extends Error {
  code?: string;
  refreshed?: boolean;

  constructor(message: string, opts?: { code?: string; refreshed?: boolean }) {
    super(message);
    this.name = "MultisigApiError";
    this.code = opts?.code;
    this.refreshed = opts?.refreshed;
  }
}

async function postJson<T>(url: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json()) as { error?: string; code?: string; refreshed?: boolean };
  if (!res.ok) {
    throw new MultisigApiError(data.error ?? `Request failed: ${url}`, {
      code: data.code,
      refreshed: data.refreshed,
    });
  }
  return data as T;
}

export async function createCounterIncrementProposal(smartAccountAddress: string) {
  return postJson<{ proposal: { id: string } }>("/api/multisig/proposals", {
    smartAccountAddress,
    operationKind: "counter_increment",
    operationParams: {},
    targetContractId: DEFAULT_COUNTER_CONTRACT,
  });
}

const NO_CONTEXT_RULE_MESSAGE =
  "This team wallet cannot send this token yet — no matching CallContract context rule on-chain. " +
  "Run setup-send-rules for this asset on the smart account (with a member signer) before proposing SAC transfers. " +
  "See LATCH_BACKEND_ECOSYSTEM.md.";

export async function createSacTransferProposal(args: {
  smartAccountAddress: string;
  assetId: string;
  recipient: string;
  amount: string;
}) {
  const recipient = args.recipient.trim();
  const amount = args.amount.trim();
  if (!recipient) throw new Error("Recipient is required");
  if (!amount) throw new Error("Amount is required");

  try {
    return await postJson<{ proposal: { id: string } }>("/api/multisig/proposals", {
      smartAccountAddress: args.smartAccountAddress,
      operationKind: "sac_transfer",
      assetId: args.assetId,
      recipient,
      amount,
      requireMatchedContextRule: true,
    });
  } catch (e) {
    if (e instanceof MultisigApiError && e.code === "NO_CONTEXT_RULE") {
      throw new MultisigApiError(NO_CONTEXT_RULE_MESSAGE, { code: e.code });
    }
    throw e;
  }
}

export async function approveProposalWithPasskey(args: {
  proposalId: string;
  memberId: string;
  credentialId: string;
  authDigestHex: string;
  rpId?: string;
}) {
  assertWebAuthnClientAvailable();
  const authDigest = Buffer.from(args.authDigestHex, "hex");
  const sig = await signWithPasskey(
    args.credentialId,
    authDigest,
    args.rpId ?? getWebauthnRpIdForCeremony()
  );
  const sigDataXdr = encodeWebAuthnSigData(sig);
  return postJson<{ approvalId: string }>(
    `/api/multisig/proposals/${args.proposalId}/approve/webauthn`,
    {
      memberId: args.memberId,
      sigDataXdrHex: sigDataXdr.toString("hex"),
    }
  );
}

export async function approveProposalWithFreighter(args: {
  proposalId: string;
  memberId: string;
}) {
  const begin = await postJson<{
    signerAddress: string;
    gAddressPreimageXdr: string;
    gAddressEntryTemplateXdr: string;
  }>(`/api/multisig/proposals/${args.proposalId}/approve/delegated/begin`, {
    memberId: args.memberId,
  });

  const signResult = await signAuthEntry(begin.gAddressPreimageXdr, {
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  if (signResult.error) {
    throw new Error(signResult.error.message || "Freighter signing failed");
  }
  if (!signResult.signedAuthEntry) {
    throw new Error("Freighter returned no signed auth entry");
  }

  return postJson<{ approvalId: string }>(
    `/api/multisig/proposals/${args.proposalId}/approve/delegated/finish`,
    {
      memberId: args.memberId,
      signedAuthEntryBase64: signResult.signedAuthEntry,
      signerAddress: signResult.signerAddress ?? begin.signerAddress,
    }
  );
}

export async function executeMultisigProposal(proposalId: string) {
  return postJson<{ hash: string; status: string }>(
    `/api/multisig/proposals/${proposalId}/execute`
  );
}
