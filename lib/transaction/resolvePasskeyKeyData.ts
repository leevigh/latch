import { rpc } from "@stellar/stellar-sdk";
import { prisma } from "@/lib/prisma";
import {
  findWebauthnKeyDataInRules,
  listContextRules,
} from "@/lib/soroban-context-rules";

function normalizeHex(raw: string): string {
  return raw.trim().toLowerCase().replace(/^0x/, "");
}

function isValidPasskeyKeyDataHex(hex: string): boolean {
  return /^[0-9a-f]+$/.test(hex) && hex.length >= 132 && hex.startsWith("04");
}

/** WebAuthn on-chain key material: 65-byte P-256 pubkey || credentialId bytes (hex). */
export function composePasskeyKeyDataHex(args: {
  publicKeyHex?: string | null;
  credentialId?: string | null;
}): string | null {
  const pub = args.publicKeyHex ? normalizeHex(args.publicKeyHex) : "";
  const cred = args.credentialId ? normalizeHex(args.credentialId) : "";
  if (!pub || !cred) return null;
  const composed = pub + cred;
  return isValidPasskeyKeyDataHex(composed) ? composed : null;
}

export function parseSetupRequestKeyDataHex(body: Record<string, unknown>): string | undefined {
  for (const key of ["keyDataHex", "key_data_hex", "keyData", "key_data"] as const) {
    const value = body[key];
    if (typeof value === "string" && value.trim()) {
      const hex = normalizeHex(value);
      if (isValidPasskeyKeyDataHex(hex)) return hex;
    }
  }

  const composed = composePasskeyKeyDataHex({
    publicKeyHex:
      typeof body.publicKeyHex === "string"
        ? body.publicKeyHex
        : typeof body.public_key_hex === "string"
          ? body.public_key_hex
          : undefined,
    credentialId:
      typeof body.credentialId === "string"
        ? body.credentialId
        : typeof body.credential_id === "string"
          ? body.credential_id
          : undefined,
  });
  return composed ?? undefined;
}

export function normalizeSetupSignerType(
  raw: unknown
): "passkey" | "phantom" | "freighter" | null {
  if (typeof raw !== "string") return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "passkey" || normalized === "webauthn") return "passkey";
  if (normalized === "phantom") return "phantom";
  if (normalized === "freighter") return "freighter";
  return null;
}

export async function resolvePasskeyKeyDataHex(args: {
  smartAccountAddress: string;
  keyDataHexFromRequest?: string | null;
  credentialId?: string | null;
  server?: rpc.Server;
  networkPassphrase?: string;
  webauthnVerifier?: string;
}): Promise<string | null> {
  const fromRequest = args.keyDataHexFromRequest
    ? normalizeHex(args.keyDataHexFromRequest)
    : "";
  if (isValidPasskeyKeyDataHex(fromRequest)) {
    return fromRequest;
  }

  try {
    const acct = await prisma.smartAccount.findFirst({
      where: {
        OR: [
          { smartAccountAddress: args.smartAccountAddress },
          ...(args.credentialId
            ? [{ credentialId: args.credentialId }]
            : []),
        ],
      },
      select: { keyDataHex: true },
    });

    const fromDb = acct?.keyDataHex ? normalizeHex(acct.keyDataHex) : "";
    if (isValidPasskeyKeyDataHex(fromDb)) {
      return fromDb;
    }
  } catch {
    // DB lookup is best-effort when extension omits keyDataHex.
  }

  if (args.server && args.networkPassphrase) {
    try {
      const rules = await listContextRules(
        args.server,
        args.networkPassphrase,
        args.smartAccountAddress
      );
      const fromChain = findWebauthnKeyDataInRules(rules, args.webauthnVerifier);
      if (fromChain) return fromChain;
    } catch {
      // On-chain scan is best-effort.
    }
  }

  return null;
}
