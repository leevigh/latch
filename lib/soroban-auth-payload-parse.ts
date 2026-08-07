import { Address, scValToNative, xdr } from "@stellar/stellar-sdk";

function authPayloadNative(
  entry: xdr.SorobanAuthorizationEntry
): Record<string, unknown> | null {
  try {
    const creds = entry.credentials();
    if (creds.switch().name !== "sorobanCredentialsAddress") return null;
    const sig = creds.address().signature();
    if (sig.switch().name === "scvVoid") return null;
    return scValToNative(sig) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** context_rule_ids from a smart-account AuthPayload signature map. */
export function contextRuleIdsFromSmartAccountAuthEntry(
  entry: xdr.SorobanAuthorizationEntry
): number[] {
  const native = authPayloadNative(entry);
  if (!native) return [];

  const raw =
    native.context_rule_ids ??
    native.contextRuleIds ??
    native.context_rule_ids_vec;
  if (!Array.isArray(raw)) return [];

  return raw
    .map((v) => Number(v))
    .filter((id) => Number.isInteger(id) && id >= 0);
}

function delegatedGFromSignerKey(key: unknown): string | null {
  if (Array.isArray(key) && key[0] === "Delegated" && typeof key[1] === "string") {
    return key[1];
  }
  if (key && typeof key === "object") {
    const o = key as Record<string, unknown>;
    if (typeof o.Delegated === "string") return o.Delegated;
  }
  if (typeof key === "string" && key.startsWith("Delegated,")) {
    const g = key.slice("Delegated,".length);
    return g.startsWith("G") ? g : null;
  }
  return null;
}

/** Delegated G-address claimed in a smart-account AuthPayload, if any. */
export function delegatedGFromSmartAccountAuthEntry(
  entry: xdr.SorobanAuthorizationEntry
): string | null {
  try {
    const native = authPayloadNative(entry);
    if (!native) return null;

    const signers = native.signers;
    if (!signers || typeof signers !== "object") return null;

    const entries = signers instanceof Map ? [...signers.entries()] : Object.entries(signers);

    for (const [key] of entries) {
      const g = delegatedGFromSignerKey(key);
      if (g) return g;
    }
  } catch {
    // ignore parse errors
  }
  return null;
}

export function smartAccountAuthUsesDelegatedG(
  entry: xdr.SorobanAuthorizationEntry,
  gAddress: string
): boolean {
  return delegatedGFromSmartAccountAuthEntry(entry) === gAddress;
}

export function hasExternalAuthPayload(entry: xdr.SorobanAuthorizationEntry): boolean {
  try {
    const creds = entry.credentials();
    if (creds.switch().name !== "sorobanCredentialsAddress") return false;
    const sig = creds.address().signature();
    if (sig.switch().name === "scvVoid") return false;
    const native = scValToNative(sig) as Record<string, unknown>;
    const signers = native?.signers;
    if (!signers || typeof signers !== "object") return false;
    const entries = signers instanceof Map ? [...signers.entries()] : Object.entries(signers);
    for (const [key] of entries) {
      if (Array.isArray(key) && key[0] === "External") return true;
      if (key && typeof key === "object" && "External" in (key as object)) return true;
    }
  } catch {
    // ignore
  }
  return false;
}
