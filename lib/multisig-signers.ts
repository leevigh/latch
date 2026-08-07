import { StrKey } from "@stellar/stellar-sdk";
import type { MultisigSignerInit } from "@/lib/smart-account-factory-multisig";

/** How this member proves control when spending (maps to factory AccountSignerInit). */
export type MultisigSignerKind = "delegated" | "webauthn" | "ed25519";

/** Off-chain draft row while building the member list (before deploy). */
export type DraftMultisigMember = {
  id: string;
  /** Display name only — not sent on-chain. */
  name: string;
  kind: MultisigSignerKind;
  /** Delegated: classic Stellar G-address (AccountSignerInit::Delegated). */
  gAddress?: string;
  /** WebAuthn: hex of 65-byte P-256 pubkey || credentialId bytes (External WebAuthn key_data). */
  keyDataHex?: string;
  /** WebAuthn: base64url credential id (for re-signing in the extension; optional in draft). */
  credentialId?: string;
  /** Ed25519: 32-byte public key hex (External Ed25519 key_data). Deploy support TBD. */
  publicKeyHex?: string;
};

export const SIGNER_KIND_META: Record<
  MultisigSignerKind,
  { label: string; short: string; collectLabel: string; hint: string }
> = {
  delegated: {
    label: "Stellar wallet",
    short: "Delegated (G)",
    collectLabel: "Stellar address (G…)",
    hint: "Classic Stellar account they control. At spend time they authorize via native Stellar auth on that G-address.",
  },
  webauthn: {
    label: "Passkey",
    short: "External (WebAuthn)",
    collectLabel: "Passkey credentials (key_data)",
    hint: "65-byte P-256 public key plus credential ID from Face ID / Touch ID / security key. Not their C-address.",
  },
  ed25519: {
    label: "Ed25519 key",
    short: "External (Ed25519)",
    collectLabel: "Ed25519 public key (32 bytes)",
    hint: "32-byte Ed25519 public key from Phantom or similar. Not their wallet C-address.",
  },
};

export function newDraftMemberId(): string {
  return crypto.randomUUID();
}

export function normalizeHex(hex: string): string {
  return hex.toLowerCase().replace(/^0x/, "").trim();
}

export function isValidGAddress(g: string): boolean {
  try {
    return StrKey.isValidEd25519PublicKey(g.trim());
  } catch {
    return false;
  }
}

export function isValidEd25519PublicKeyHex(hex: string): boolean {
  const h = normalizeHex(hex);
  return h.length === 64 && /^[0-9a-f]+$/.test(h);
}

export function isValidWebauthnKeyDataHex(hex: string): boolean {
  const h = normalizeHex(hex);
  if (h.length < 132 || !/^[0-9a-f]+$/.test(h)) return false;
  // Factory expects > 65 bytes and first byte 0x04 (uncompressed P-256)
  return h.startsWith("04");
}

export function memberCredentialFingerprint(m: DraftMultisigMember): string {
  if (m.kind === "delegated" && m.gAddress) {
    return truncateMiddle(m.gAddress, 8, 6);
  }
  if (m.kind === "webauthn" && m.keyDataHex) {
    return `passkey · ${truncateMiddle(normalizeHex(m.keyDataHex), 6, 4)}`;
  }
  if (m.kind === "ed25519" && m.publicKeyHex) {
    return `ed25519 · ${truncateMiddle(normalizeHex(m.publicKeyHex), 6, 4)}`;
  }
  return "—";
}

export function validateDraftMember(m: DraftMultisigMember): string | null {
  if (!m.name.trim()) return "Name is required.";
  if (m.kind === "delegated") {
    if (!m.gAddress?.trim()) return "Stellar G-address is required.";
    if (!isValidGAddress(m.gAddress)) return "Invalid Stellar G-address.";
    return null;
  }
  if (m.kind === "webauthn") {
    if (!m.keyDataHex?.trim()) return "Passkey key_data is required.";
    if (!isValidWebauthnKeyDataHex(m.keyDataHex)) {
      return "Invalid passkey key_data (expected hex, >65 bytes, starts with 04).";
    }
    return null;
  }
  if (m.kind === "ed25519") {
    if (!m.publicKeyHex?.trim()) return "Ed25519 public key is required.";
    if (!isValidEd25519PublicKeyHex(m.publicKeyHex)) {
      return "Invalid Ed25519 public key (expected 64 hex chars).";
    }
    return null;
  }
  return "Unknown signer kind.";
}

export function draftMemberToFactorySigner(m: DraftMultisigMember): MultisigSignerInit | null {
  if (validateDraftMember(m)) return null;
  const label = m.name.trim();
  if (m.kind === "delegated") {
    return { type: "delegated", gAddress: m.gAddress!.trim(), label };
  }
  if (m.kind === "webauthn") {
    return { type: "webauthn", keyDataHex: normalizeHex(m.keyDataHex!), label };
  }
  return null;
}

export function draftMembersToFactorySigners(members: DraftMultisigMember[]): MultisigSignerInit[] {
  return members
    .map(draftMemberToFactorySigner)
    .filter((s): s is MultisigSignerInit => s !== null);
}

function truncateMiddle(s: string, head: number, tail: number): string {
  if (s.length <= head + tail + 3) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

export const MULTISIG_DRAFT_STORAGE_KEY = "latch-multisig-draft-members";

export function loadDraftMembersFromStorage(): DraftMultisigMember[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(MULTISIG_DRAFT_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function saveDraftMembersToStorage(members: DraftMultisigMember[]): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(MULTISIG_DRAFT_STORAGE_KEY, JSON.stringify(members));
}
