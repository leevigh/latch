import { generateAuthenticationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/types";
import * as crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { nowMs } from "@/lib/db";
import {
  coseEc2ToRawP256Uncompressed,
  fromBase64Url,
  getOriginFromClientDataJSON,
  resolveWebauthnCeremonyContext,
  resolveWebauthnFinishVerification,
  WebauthnCeremonyConfigError,
} from "@/lib/webauthn-server";
import { buildRegistrationOptions } from "@/lib/webauthn-registration-options";
import { extractCredentialIdFromKeyDataHex } from "@/lib/multisig-draft";
import { getOrCreateSession } from "@/lib/session";

const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export function draftRegisterPurpose(draftId: string): string {
  return `multisig_draft_register:${draftId}`;
}

export function draftAuthPurpose(draftId: string): string {
  return `multisig_draft_auth:${draftId}`;
}

export async function beginDraftWebauthnRegistration(args: {
  request: Request;
  draftId: string;
  challengeUserId: string;
  displayName?: string;
  chromeExtensionId?: string;
}): Promise<{ options: PublicKeyCredentialCreationOptionsJSON }> {
  const { options } = await buildRegistrationOptions({
    request: args.request,
    sessionUserId: args.challengeUserId,
    displayName: args.displayName,
    chromeExtensionId: args.chromeExtensionId,
    challengePurpose: draftRegisterPurpose(args.draftId),
  });
  return { options };
}

export async function finishDraftWebauthnRegistration(args: {
  request: Request;
  draftId: string;
  challengeUserId: string;
  response: RegistrationResponseJSON;
  chromeExtensionId?: string;
  persistCredentialForUserId?: string | null;
}): Promise<{ credentialId: string; keyDataHex: string }> {
  const now = nowMs();
  const purpose = draftRegisterPurpose(args.draftId);

  const challengeRow = await prisma.webauthnChallenge.findFirst({
    where: { userId: args.challengeUserId, purpose },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      challenge: true,
      expiresAt: true,
      rpId: true,
      origin: true,
      webauthnUserHandle: true,
    },
  });

  if (!challengeRow || challengeRow.expiresAt <= BigInt(now)) {
    throw new Error("Registration challenge expired");
  }

  const clientDataOrigin = getOriginFromClientDataJSON(args.response.response.clientDataJSON);
  const verifyParams = resolveWebauthnFinishVerification({
    challengeOrigin: challengeRow.origin,
    challengeRpId: challengeRow.rpId,
    clientDataOrigin,
    chromeExtensionId: args.chromeExtensionId,
    request: args.request,
  });

  const verification = await verifyRegistrationResponse({
    response: args.response,
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: verifyParams.expectedOrigin,
    expectedRPID: verifyParams.expectedRPID,
    requireUserVerification: false,
  });

  if (!verification.verified || !verification.registrationInfo) {
    throw new Error("Registration verification failed");
  }

  const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;
  const credentialId = credential.id;
  const credentialIdBytes = fromBase64Url(credentialId);
  const cosePublicKey = Buffer.from(credential.publicKey);
  const rawPublicKey = coseEc2ToRawP256Uncompressed(cosePublicKey);
  const keyData = Buffer.concat([rawPublicKey, credentialIdBytes]);
  const keyDataHex = keyData.toString("hex");

  if (args.persistCredentialForUserId) {
    const credExists = await prisma.webauthnCredential.findUnique({
      where: { credentialId },
      select: { id: true, userId: true },
    });
    if (credExists && credExists.userId !== args.persistCredentialForUserId) {
      throw new Error("This passkey is already registered to a different user session.");
    }
    const credId = credExists?.id ?? crypto.randomUUID();
    const transports = JSON.stringify(
      credential.transports ?? args.response.response.transports ?? null
    );
    await prisma.webauthnCredential.upsert({
      where: { credentialId },
      create: {
        id: credId,
        userId: args.persistCredentialForUserId,
        credentialId,
        credentialIdBytes,
        cosePublicKey,
        p256RawPublicKey: rawPublicKey,
        signCount: credential.counter,
        transports,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp ? 1 : 0,
        webauthnUserHandle: challengeRow.webauthnUserHandle,
        createdAt: BigInt(now),
      },
      update: {
        userId: args.persistCredentialForUserId,
        credentialIdBytes,
        cosePublicKey,
        p256RawPublicKey: rawPublicKey,
        signCount: credential.counter,
        transports,
        deviceType: credentialDeviceType,
        backedUp: credentialBackedUp ? 1 : 0,
        ...(challengeRow.webauthnUserHandle
          ? { webauthnUserHandle: challengeRow.webauthnUserHandle }
          : {}),
      },
    });
  }

  await prisma.webauthnChallenge.delete({ where: { id: challengeRow.id } });

  return { credentialId, keyDataHex };
}

export async function beginDraftWebauthnAuthentication(args: {
  request: Request;
  draftId: string;
  challengeUserId: string;
  chromeExtensionId?: string;
  sessionUserId?: string | null;
}): Promise<{ options: PublicKeyCredentialRequestOptionsJSON }> {
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

  let allowCredentials: { id: string; type: "public-key"; transports?: string[] }[] | undefined;
  if (args.sessionUserId) {
    const creds = await prisma.webauthnCredential.findMany({
      where: { userId: args.sessionUserId },
      select: { credentialId: true, transports: true },
    });
    if (creds.length > 0) {
      allowCredentials = creds.map((c) => ({
        id: c.credentialId,
        type: "public-key" as const,
        transports: (() => {
          try {
            const parsed = c.transports ? JSON.parse(c.transports) : null;
            return Array.isArray(parsed) ? parsed : undefined;
          } catch {
            return undefined;
          }
        })(),
      }));
    }
  }

  const options = (await generateAuthenticationOptions({
    rpID,
    userVerification: "preferred",
    allowCredentials,
    timeout: 60_000,
  })) as PublicKeyCredentialRequestOptionsJSON;

  if (!options?.challenge) {
    throw new Error("WebAuthn authentication options missing challenge");
  }

  const issuedRpId = typeof options.rpId === "string" ? options.rpId : rpID;
  const now = nowMs();
  await prisma.webauthnChallenge.create({
    data: {
      id: crypto.randomUUID(),
      userId: args.challengeUserId,
      purpose: draftAuthPurpose(args.draftId),
      challenge: options.challenge,
      rpId: issuedRpId,
      origin: expectedOrigin,
      expiresAt: BigInt(now + CHALLENGE_TTL_MS),
      createdAt: BigInt(now),
    },
  });

  return { options };
}

export async function finishDraftWebauthnAuthentication(args: {
  request: Request;
  draftId: string;
  challengeUserId: string;
  response: AuthenticationResponseJSON;
  chromeExtensionId?: string;
}): Promise<{ credentialId: string; keyDataHex: string }> {
  const now = nowMs();
  const purpose = draftAuthPurpose(args.draftId);

  const challengeRow = await prisma.webauthnChallenge.findFirst({
    where: { userId: args.challengeUserId, purpose },
    orderBy: { createdAt: "desc" },
    select: { id: true, challenge: true, expiresAt: true, rpId: true, origin: true },
  });

  if (!challengeRow || challengeRow.expiresAt <= BigInt(now)) {
    throw new Error("Authentication challenge expired");
  }

  const clientDataOrigin = getOriginFromClientDataJSON(args.response.response.clientDataJSON);
  const verifyParams = resolveWebauthnFinishVerification({
    challengeOrigin: challengeRow.origin,
    challengeRpId: challengeRow.rpId,
    clientDataOrigin,
    chromeExtensionId: args.chromeExtensionId,
    request: args.request,
  });

  const credentialId = args.response.id;
  const cred = await prisma.webauthnCredential.findUnique({
    where: { credentialId },
    select: {
      credentialId: true,
      credentialIdBytes: true,
      cosePublicKey: true,
      signCount: true,
      p256RawPublicKey: true,
    },
  });

  if (!cred) {
    throw new Error(
      "No Latch passkey found for this credential. Create a new passkey for this team wallet instead."
    );
  }

  const verification = await verifyAuthenticationResponse({
    response: args.response,
    expectedChallenge: challengeRow.challenge,
    expectedOrigin: verifyParams.expectedOrigin,
    expectedRPID: verifyParams.expectedRPID,
    requireUserVerification: false,
    credential: {
      id: cred.credentialId,
      publicKey: new Uint8Array(cred.cosePublicKey),
      counter: cred.signCount,
    },
  });

  if (!verification.verified) {
    throw new Error("Authentication verification failed");
  }

  await prisma.webauthnCredential.update({
    where: { credentialId },
    data: { signCount: verification.authenticationInfo.newCounter },
  });

  const rawPublicKey = cred.p256RawPublicKey;
  const keyData = Buffer.concat([rawPublicKey, cred.credentialIdBytes]);
  const keyDataHex = keyData.toString("hex");

  await prisma.webauthnChallenge.delete({ where: { id: challengeRow.id } });

  const derivedCredId = extractCredentialIdFromKeyDataHex(keyDataHex);
  return {
    credentialId: derivedCredId ?? credentialId,
    keyDataHex,
  };
}

/** Real users.id for invite join ceremonies (webauthn_challenges FK). */
export async function joinChallengeUserId(): Promise<string> {
  const { userId } = await getOrCreateSession();
  return userId;
}
