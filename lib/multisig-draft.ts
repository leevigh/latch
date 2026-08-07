import * as crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { nowMs } from "@/lib/db";
import {
  draftMemberToFactorySigner,
  draftMembersToFactorySigners,
  normalizeHex,
  validateDraftMember,
  type DraftMultisigMember,
  type MultisigSignerKind,
} from "@/lib/multisig-signers";
import { randomAccountSaltHex } from "@/lib/smart-account-factory-multisig";

export const MULTISIG_DRAFT_ID_STORAGE_KEY = "latch-multisig-draft-id";
export const DRAFT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type DraftMemberRow = {
  id: string;
  label: string;
  memberType: string;
  gAddress: string | null;
  keyDataHex: string | null;
  credentialId: string | null;
  publicKeyHex: string | null;
  source: string;
  createdAt: bigint;
};

export function generateInviteToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

export function extractCredentialIdFromKeyDataHex(keyDataHex: string): string | null {
  const h = normalizeHex(keyDataHex);
  if (h.length < 132) return null;
  const tail = Buffer.from(h.slice(130), "hex");
  if (tail.length === 0) return null;
  return tail.toString("base64url");
}

export function draftRowToMember(row: DraftMemberRow): DraftMultisigMember {
  return {
    id: row.id,
    name: row.label,
    kind: row.memberType as MultisigSignerKind,
    gAddress: row.gAddress ?? undefined,
    keyDataHex: row.keyDataHex ?? undefined,
    credentialId: row.credentialId ?? undefined,
    publicKeyHex: row.publicKeyHex ?? undefined,
  };
}

export function memberInputToDraftMember(
  id: string,
  input: {
    label: string;
    memberType: MultisigSignerKind;
    gAddress?: string;
    keyDataHex?: string;
    credentialId?: string;
    publicKeyHex?: string;
  }
): DraftMultisigMember {
  let credentialId = input.credentialId?.trim();
  if (!credentialId && input.keyDataHex) {
    credentialId = extractCredentialIdFromKeyDataHex(input.keyDataHex) ?? undefined;
  }
  return {
    id,
    name: input.label.trim(),
    kind: input.memberType,
    gAddress: input.gAddress?.trim(),
    keyDataHex: input.keyDataHex ? normalizeHex(input.keyDataHex) : undefined,
    credentialId,
    publicKeyHex: input.publicKeyHex ? normalizeHex(input.publicKeyHex) : undefined,
  };
}

export function memberFingerprintForRow(row: DraftMemberRow): string {
  return validateDraftMember(draftRowToMember(row)) ? "invalid" : "ok";
}

export async function getDraftForCreator(draftId: string, creatorUserId: string) {
  const draft = await prisma.multisigDraft.findFirst({
    where: { id: draftId, creatorUserId },
    include: { members: { orderBy: { createdAt: "asc" } } },
  });
  return draft;
}

export async function getDraftByInviteToken(inviteToken: string) {
  const draft = await prisma.multisigDraft.findUnique({
    where: { inviteToken },
    include: {
      members: { orderBy: { createdAt: "asc" } },
      user: { select: { id: true } },
    },
  });
  if (!draft) return null;
  if (draft.expiresAt && draft.expiresAt < BigInt(nowMs())) return null;
  if (draft.status !== "collecting") return null;
  return draft;
}

export function assertDraftCollecting(status: string): void {
  if (status !== "collecting") {
    throw new Error("This team wallet draft is no longer accepting members.");
  }
}

export function duplicateMemberError(
  existing: DraftMultisigMember[],
  candidate: DraftMultisigMember
): string | null {
  for (const m of existing) {
    if (m.kind === "delegated" && candidate.kind === "delegated") {
      if (m.gAddress && candidate.gAddress && m.gAddress === candidate.gAddress) {
        return "This Stellar address is already on the draft.";
      }
    }
    if (m.kind === "webauthn" && candidate.kind === "webauthn") {
      if (m.keyDataHex && candidate.keyDataHex && m.keyDataHex === candidate.keyDataHex) {
        return "This passkey is already on the draft.";
      }
    }
    if (m.kind === "ed25519" && candidate.kind === "ed25519") {
      if (m.publicKeyHex && candidate.publicKeyHex && m.publicKeyHex === candidate.publicKeyHex) {
        return "This Ed25519 public key is already on the draft.";
      }
    }
  }
  return null;
}

export function serializeDraft(draft: {
  id: string;
  threshold: number;
  accountSaltHex: string;
  inviteToken: string;
  status: string;
  predictedAddress: string | null;
  smartAccountAddress: string | null;
  createdAt: bigint;
  expiresAt: bigint | null;
  members: DraftMemberRow[];
}) {
  const members = draft.members.map((row) => {
    const m = draftRowToMember(row);
    const err = validateDraftMember(m);
    return {
      id: row.id,
      label: row.label,
      memberType: row.memberType,
      gAddress: row.gAddress,
      keyDataHex: row.keyDataHex,
      credentialId: row.credentialId,
      publicKeyHex: row.publicKeyHex,
      source: row.source,
      valid: !err,
      validationError: err,
      fingerprint: err ? null : memberCredentialFingerprintSafe(m),
    };
  });

  const validCount = members.filter((m) => m.valid).length;
  const factorySigners = draftMembersToFactorySigners(
    draft.members.map(draftRowToMember).filter((m) => !validateDraftMember(m))
  );

  return {
    id: draft.id,
    threshold: draft.threshold,
    accountSaltHex: draft.accountSaltHex,
    inviteToken: draft.inviteToken,
    status: draft.status,
    predictedAddress: draft.predictedAddress,
    smartAccountAddress: draft.smartAccountAddress,
    createdAt: draft.createdAt.toString(),
    expiresAt: draft.expiresAt?.toString() ?? null,
    members,
    validMemberCount: validCount,
    canDeploy:
      draft.status === "collecting" &&
      validCount >= 2 &&
      draft.threshold >= 1 &&
      draft.threshold <= validCount &&
      factorySigners.length >= 2 &&
      factorySigners.every((s) => s.type === "webauthn" || s.type === "delegated"),
  };
}

function memberCredentialFingerprintSafe(m: DraftMultisigMember): string {
  if (m.kind === "delegated" && m.gAddress) {
    return `G…${m.gAddress.slice(-6)}`;
  }
  if (m.kind === "webauthn" && m.keyDataHex) {
    return `passkey · ${m.keyDataHex.slice(0, 8)}…`;
  }
  if (m.kind === "ed25519" && m.publicKeyHex) {
    return `ed25519 · ${m.publicKeyHex.slice(0, 8)}…`;
  }
  return "—";
}

export async function createMultisigDraft(creatorUserId: string) {
  const now = nowMs();
  const id = crypto.randomUUID();
  return prisma.multisigDraft.create({
    data: {
      id,
      creatorUserId,
      threshold: 2,
      accountSaltHex: randomAccountSaltHex(),
      inviteToken: generateInviteToken(),
      status: "collecting",
      createdAt: BigInt(now),
      expiresAt: BigInt(now + DRAFT_INVITE_TTL_MS),
    },
    include: { members: true },
  });
}

export function buildInviteUrl(request: Request, inviteToken: string): string {
  const proto = request.headers.get("x-forwarded-proto") || "http";
  const host = request.headers.get("host") || "localhost:3000";
  return `${proto}://${host}/multisig/join/${inviteToken}`;
}

export { draftMemberToFactorySigner, draftMembersToFactorySigners };
