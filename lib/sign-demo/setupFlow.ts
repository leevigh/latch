import {
  postSetupContextRule,
  postSetupSendRules,
  type SetupSendRulesBody,
} from "@/lib/context-rule-setup";
import { getAssetCatalog } from "@/lib/stellar-assets";
import { Networks } from "@stellar/stellar-sdk";
import { LatchWalletError, signWithLatch } from "./latchWallet";
import type { Network } from "./types";

export type SignerFields = {
  signerType: "passkey" | "phantom" | "freighter";
  signerG?: string;
  publicKeyHex?: string;
  keyDataHex?: string;
};

export type SetupPhase =
  | "building_setup"
  | "awaiting_wallet_signature"
  | "submitted_on_chain"
  | "waiting_propagation"
  | "already_configured";

type RuleSigner = {
  kind?: string;
  gAddress?: string;
  keyDataHex?: string;
  verifierAddress?: string;
};

type RuleRow = {
  signers?: RuleSigner[];
};

function networkPassphrase(network: Network): string {
  return network === "mainnet" ? Networks.PUBLIC : Networks.TESTNET;
}

/** True when targetContractId matches a catalog SAC on this network. */
export function catalogAssetIdForContract(
  network: Network,
  targetContractId: string
): string | null {
  const catalog = getAssetCatalog(networkPassphrase(network));
  const hit = catalog.find((a) => a.contractId === targetContractId);
  return hit?.assetId ?? null;
}

export function parseCallContractIdFromMessage(message: string): string | null {
  const m = message.match(/CallContract\((C[A-Z0-9]+)\)/i);
  return m?.[1] ?? null;
}

function fieldsComplete(fields: SignerFields): boolean {
  if (fields.signerType === "freighter") return Boolean(fields.signerG?.trim());
  if (fields.signerType === "phantom") return Boolean(fields.publicKeyHex?.trim());
  if (fields.signerType === "passkey") return Boolean(fields.keyDataHex?.trim());
  return false;
}

function findPasskeyKeyData(rules: RuleRow[]): string | null {
  for (const rule of rules) {
    for (const signer of rule.signers ?? []) {
      if (signer.kind !== "External" || !signer.keyDataHex) continue;
      const hex = signer.keyDataHex.trim().toLowerCase();
      if (hex.length >= 132 && hex.startsWith("04")) return hex;
    }
  }
  return null;
}

function findDelegatedG(rules: RuleRow[]): string | null {
  for (const rule of rules) {
    for (const signer of rule.signers ?? []) {
      if (signer.kind === "Delegated" && signer.gAddress?.startsWith("G")) {
        return signer.gAddress;
      }
    }
  }
  return null;
}

/** Prefer Section A; else infer from Latch G-address / on-chain context rules. */
export async function resolveSignerFieldsForSetup(args: {
  smartAccountAddress: string;
  network: Network;
  fields?: Partial<SignerFields> | null;
  latchAccount?: string | null;
}): Promise<SignerFields> {
  const partial = args.fields ?? {};
  if (
    partial.signerType &&
    fieldsComplete({
      signerType: partial.signerType,
      signerG: partial.signerG,
      publicKeyHex: partial.publicKeyHex,
      keyDataHex: partial.keyDataHex,
    })
  ) {
    return {
      signerType: partial.signerType,
      signerG: partial.signerG?.trim() || undefined,
      publicKeyHex: partial.publicKeyHex?.trim() || undefined,
      keyDataHex: partial.keyDataHex?.trim() || undefined,
    };
  }

  const latch = args.latchAccount?.trim();
  if (latch?.startsWith("G") && (!partial.signerType || partial.signerType === "freighter")) {
    return { signerType: "freighter", signerG: latch };
  }

  const res = await fetch(
    `/api/smart-account/context-rules?address=${encodeURIComponent(
      args.smartAccountAddress
    )}&network=${encodeURIComponent(args.network)}`
  );
  const data = (await res.json()) as {
    rules?: RuleRow[];
    error?: string;
  };
  if (!res.ok) {
    throw new Error(data.error ?? "Failed to load context rules for setup.");
  }
  const rules = data.rules ?? [];

  const keyDataHex = findPasskeyKeyData(rules);
  if (keyDataHex) {
    return { signerType: "passkey", keyDataHex };
  }

  const gAddress = findDelegatedG(rules);
  if (gAddress) {
    return { signerType: "freighter", signerG: gAddress };
  }

  if (partial.signerType === "freighter" && partial.signerG?.trim()) {
    return { signerType: "freighter", signerG: partial.signerG.trim() };
  }
  if (partial.signerType === "passkey" && partial.keyDataHex?.trim()) {
    return { signerType: "passkey", keyDataHex: partial.keyDataHex.trim() };
  }
  if (partial.signerType === "phantom" && partial.publicKeyHex?.trim()) {
    return { signerType: "phantom", publicKeyHex: partial.publicKeyHex.trim() };
  }

  throw new Error(
    "Could not infer a signer for setup-send-rules. Select signer type in Section A (and G / key material), or connect Latch."
  );
}

function requireSetupSignerBody(
  smartAccountAddress: string,
  fields: SignerFields,
  extra: Partial<SetupSendRulesBody> = {}
): SetupSendRulesBody {
  const { signerType } = fields;
  if (signerType === "freighter" && !fields.signerG?.trim()) {
    throw new Error(
      "Select signer type Freighter and enter the signer G-address in Section A before setup."
    );
  }
  if (signerType === "phantom" && !fields.publicKeyHex?.trim()) {
    throw new Error(
      "Phantom setup needs publicKeyHex (64 hex chars) in Section A."
    );
  }
  if (signerType === "passkey" && !fields.keyDataHex?.trim()) {
    throw new Error(
      "Passkey setup needs keyDataHex in Section A (from context rules or wallet), or use Freighter."
    );
  }

  return {
    smartAccountAddress,
    signerType,
    ...(signerType === "freighter" ? { gAddress: fields.signerG!.trim() } : {}),
    ...(signerType === "phantom"
      ? { publicKeyHex: fields.publicKeyHex!.trim() }
      : {}),
    ...(signerType === "passkey" ? { keyDataHex: fields.keyDataHex!.trim() } : {}),
    ...extra,
  };
}

async function waitForRulePropagation(): Promise<void> {
  // Brief pause so the next discoverContextRule sees the newly submitted rule.
  await new Promise((r) => setTimeout(r, 1500));
}

function setupHashStatus(hash: string): string {
  return `Setup submitted (tx ${hash.slice(0, 12)}…). Retrying build…`;
}

function phaseStatus(phase: SetupPhase, detail?: string): string {
  switch (phase) {
    case "building_setup":
      return "Building setup transaction…";
    case "awaiting_wallet_signature":
      return "Approve setup in Latch wallet…";
    case "submitted_on_chain":
      return detail
        ? `Setup submitted (tx ${detail.slice(0, 12)}…).`
        : "Setup submitted on-chain.";
    case "waiting_propagation":
      return "Waiting for context rule to propagate…";
    case "already_configured":
      return "Context rule already configured.";
  }
}

async function submitBundlerDelegatedSetup(
  setup: Record<string, unknown>
): Promise<string | null> {
  if (setup.submitMethod !== "bundler-delegated") return null;
  const txXdr = setup.txXdr;
  const smartAccountAuthEntryXdr = setup.smartAccountAuthEntryXdr;
  if (typeof txXdr !== "string" || typeof smartAccountAuthEntryXdr !== "string") {
    return null;
  }

  const res = await fetch("/api/transaction/submit-delegated", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      txXdr,
      smartAccountAuthEntryXdr,
      authEntriesXdr: setup.authEntriesXdr,
      smartAccountAuthEntryIndex: setup.smartAccountAuthEntryIndex,
      contextRuleId: setup.contextRuleId,
      gAddressEntryTemplateXdr: setup.gAddressEntryTemplateXdr,
    }),
  });
  const data = (await res.json()) as { hash?: string; error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? "Bundler-delegated setup submit failed");
  }
  return typeof data.hash === "string" ? data.hash : null;
}

/**
 * Sign + submit a setup tx via the Latch extension (correct WebAuthn rpId /
 * delegated path). setup-* APIs only build unsigned packages — they never
 * install the rule by themselves.
 */
async function submitSetupViaLatchWallet(args: {
  setup: Record<string, unknown>;
  network: Network;
  smartAccountAddress: string;
  onPhase?: (phase: SetupPhase, status: string) => void;
}): Promise<string> {
  const { setup, network, smartAccountAddress, onPhase } = args;
  const txXdr = setup.txXdr;
  if (typeof txXdr !== "string" || !txXdr) {
    throw new Error("Setup response missing txXdr.");
  }

  onPhase?.(
    "awaiting_wallet_signature",
    phaseStatus("awaiting_wallet_signature")
  );

  try {
    const res = await signWithLatch({
      xdr: txXdr,
      network,
      accountToSign: smartAccountAddress,
      submit: true,
    });
    if (!res.txHash?.trim()) {
      throw new Error(
        "Latch wallet signed setup but did not return a transaction hash. Setup must be submitted on-chain."
      );
    }
    return res.txHash.trim();
  } catch (e) {
    if (e instanceof LatchWalletError && e.code === "user_rejected") {
      throw new LatchWalletError("Setup signing cancelled in Latch wallet.", "user_rejected");
    }
    throw e;
  }
}

/**
 * Build + sign + submit a send-rule or arbitrary CallContract rule.
 * Returns after the rule is on-chain (or alreadyConfigured).
 *
 * Signing goes through `window.latch.signTransaction` so passkeys use the
 * extension rpId (never page-hostname WebAuthn).
 */
export async function runContextRuleSetupAndSign(args: {
  smartAccountAddress: string;
  network: Network;
  fields?: Partial<SignerFields> | null;
  /** Prefer catalog send-rules when set. */
  assetId?: string;
  /** For non-catalog targets (prepare-sign recovery). */
  targetContractId?: string;
  latchAccount?: string | null;
  onPhase?: (phase: SetupPhase, status: string) => void;
}): Promise<{ alreadyConfigured: boolean; status: string }> {
  const {
    smartAccountAddress,
    network,
    assetId,
    targetContractId,
    latchAccount,
    onPhase,
  } = args;

  const emit = (phase: SetupPhase, detail?: string) => {
    const status = phaseStatus(phase, detail);
    onPhase?.(phase, status);
    return status;
  };

  const fields = await resolveSignerFieldsForSetup({
    smartAccountAddress,
    network,
    fields: args.fields,
    latchAccount,
  });

  emit("building_setup");

  let setup: Record<string, unknown> & { alreadyConfigured?: boolean };

  if (assetId) {
    setup = await postSetupSendRules(
      requireSetupSignerBody(smartAccountAddress, fields, { assetId })
    );
  } else if (targetContractId) {
    const catalogId = catalogAssetIdForContract(network, targetContractId);
    if (catalogId) {
      setup = await postSetupSendRules(
        requireSetupSignerBody(smartAccountAddress, fields, {
          assetId: catalogId,
        })
      );
    } else {
      const body = requireSetupSignerBody(smartAccountAddress, fields);
      setup = await postSetupContextRule({
        smartAccountAddress: body.smartAccountAddress,
        signerType: body.signerType,
        targetContractId,
        publicKeyHex: body.publicKeyHex,
        keyDataHex: body.keyDataHex,
        gAddress: body.gAddress,
      });
    }
  } else {
    throw new Error("assetId or targetContractId required for context-rule setup.");
  }

  if (setup.alreadyConfigured) {
    return {
      alreadyConfigured: true,
      status: emit("already_configured"),
    };
  }

  // Admin rule is bundler-only Delegated: server can finish setup without a wallet prompt.
  const bundlerHash = await submitBundlerDelegatedSetup(setup);
  if (bundlerHash) {
    emit("submitted_on_chain", bundlerHash);
    emit("waiting_propagation");
    await waitForRulePropagation();
    return {
      alreadyConfigured: false,
      status: setupHashStatus(bundlerHash),
    };
  }

  const hash = await submitSetupViaLatchWallet({
    setup,
    network,
    smartAccountAddress,
    onPhase,
  });
  emit("submitted_on_chain", hash);
  emit("waiting_propagation");
  await waitForRulePropagation();
  return {
    alreadyConfigured: false,
    status: setupHashStatus(hash),
  };
}
