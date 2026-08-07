import { generateRegistrationOptions } from "@simplewebauthn/server";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/types";
import * as crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { nowMs } from "@/lib/db";
import {
  resolveWebauthnCeremonyContext,
  stableUserIdBytes,
  WebauthnCeremonyConfigError,
} from "@/lib/webauthn-server";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export type BuildRegistrationOptionsArgs = {
  request: Request;
  sessionUserId: string;
  displayName?: string;
  chromeExtensionId?: string;
  /** Challenge purpose, e.g. "registration" or draftRegisterPurpose(draftId). */
  challengePurpose: string;
};

export type BuildRegistrationOptionsResult = {
  options: PublicKeyCredentialCreationOptionsJSON;
  webauthnUserHandle: string;
};

/**
 * Shared registration-options builder for personal and multisig enroll paths.
 * Allocates a unique WebAuthn user.id per enrollment; session userId remains the credential owner.
 */
export async function buildRegistrationOptions(
  args: BuildRegistrationOptionsArgs
): Promise<BuildRegistrationOptionsResult> {
  let rpID: string;
  let expectedOrigin: string;
  try {
    ({ rpId: rpID, origin: expectedOrigin } = resolveWebauthnCeremonyContext(
      args.request,
      args.chromeExtensionId
    ));
  } catch (e) {
    if (e instanceof WebauthnCeremonyConfigError) throw e;
    throw e;
  }

  const label =
    args.displayName?.trim() || `Latch passkey ${crypto.randomUUID().slice(0, 8)}`;
  const webauthnUserHandle = crypto.randomUUID();

  const existing = await prisma.webauthnCredential.findMany({
    where: { userId: args.sessionUserId },
    select: { credentialId: true },
  });

  const options = (await generateRegistrationOptions({
    rpID,
    rpName: "Latch",
    userID: stableUserIdBytes(webauthnUserHandle),
    userName: label,
    userDisplayName: label,
    attestationType: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      userVerification: "preferred",
    },
    supportedAlgorithmIDs: [-7],
    timeout: 60_000,
    excludeCredentials: existing.map((c) => ({
      id: c.credentialId,
      type: "public-key" as const,
    })),
  })) as PublicKeyCredentialCreationOptionsJSON;

  if (!options?.challenge) {
    throw new Error("WebAuthn registration options missing challenge");
  }

  const issuedRpId = typeof options.rp?.id === "string" ? options.rp.id : rpID;
  const now = nowMs();

  await prisma.webauthnChallenge.create({
    data: {
      id: crypto.randomUUID(),
      userId: args.sessionUserId,
      purpose: args.challengePurpose,
      challenge: options.challenge,
      rpId: issuedRpId,
      origin: expectedOrigin,
      webauthnUserHandle,
      expiresAt: BigInt(now + CHALLENGE_TTL_MS),
      createdAt: BigInt(now),
    },
  });

  return { options, webauthnUserHandle };
}
