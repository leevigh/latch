import { Address, xdr } from "@stellar/stellar-sdk";

export type AuthEntryRole = "smart_account_custom" | "delegated_native" | "other";

/** Simulation may return each auth entry as base64 or as an XDR object. */
export function normalizeAuthEntries(auth: unknown): xdr.SorobanAuthorizationEntry[] {
  if (!Array.isArray(auth) || auth.length === 0) {
    return [];
  }
  return auth.map((raw) =>
    typeof raw === "string"
      ? xdr.SorobanAuthorizationEntry.fromXDR(raw, "base64")
      : (raw as xdr.SorobanAuthorizationEntry)
  );
}

export function setAddressCredentialExpiration(
  entries: xdr.SorobanAuthorizationEntry[],
  latestLedger: number,
  ledgerDelta: number
): number {
  const validUntil = latestLedger + ledgerDelta;
  for (const entry of entries) {
    const creds = entry.credentials();
    if (creds.switch().name !== "sorobanCredentialsAddress") continue;
    creds.address().signatureExpirationLedger(validUntil);
  }
  return validUntil;
}

/** Credential address as `C...` / `G...` when credentials are address-based; otherwise null. */
export function addressStringFromCredentials(entry: xdr.SorobanAuthorizationEntry): string | null {
  const creds = entry.credentials();
  if (creds.switch().name !== "sorobanCredentialsAddress") return null;
  try {
    return Address.fromScAddress(creds.address().address()).toString();
  } catch {
    return null;
  }
}

export function classifyAuthEntryRole(
  entry: xdr.SorobanAuthorizationEntry,
  smartAccountAddress: string,
  signerG?: string | null
): AuthEntryRole {
  const addr = addressStringFromCredentials(entry);
  if (!addr) return "other";
  if (addr === smartAccountAddress) return "smart_account_custom";
  if (signerG && addr === signerG) return "delegated_native";
  return "other";
}

/** Best-effort root invocation label for logs (contract + fn). */
export function rootInvocationSummary(entry: xdr.SorobanAuthorizationEntry): string {
  try {
    const inv = entry.rootInvocation();
    const fn = inv.function();
    const sw = fn.switch().name;
    if (sw === "sorobanAuthorizedFunctionTypeContractFn") {
      const args = fn.contractFn();
      const contractAddr = Address.fromScAddress(args.contractAddress()).toString();
      const nameBuf = args.functionName();
      const name = typeof nameBuf === "string" ? nameBuf : Buffer.from(nameBuf).toString("utf8");
      return `${contractAddr}:${name}`;
    }
    return sw;
  } catch {
    return "(unreadable)";
  }
}

export function credentialSwitchName(entry: xdr.SorobanAuthorizationEntry): string {
  try {
    return entry.credentials().switch().name;
  } catch {
    return "unknown";
  }
}

/** True when address credentials have no signature yet (simulation placeholder). */
export function isUnsignedAddressAuthEntry(entry: xdr.SorobanAuthorizationEntry): boolean {
  const creds = entry.credentials();
  if (creds.switch().name !== "sorobanCredentialsAddress") return false;
  const sig = creds.address().signature();
  const sw = sig.switch().name;
  if (sw === "scvVoid") return true;
  if (sw === "scvVec") {
    const vec = sig.vec();
    return !vec || vec.length === 0;
  }
  return false;
}

/** Contract id string (`C...`) for a Soroban auth entry root, or null. */
export function rootContractIdString(entry: xdr.SorobanAuthorizationEntry): string | null {
  try {
    const inv = entry.rootInvocation();
    const fn = inv.function();
    if (fn.switch().name !== "sorobanAuthorizedFunctionTypeContractFn") return null;
    return Address.fromScAddress(fn.contractFn().contractAddress()).toString();
  } catch {
    return null;
  }
}
