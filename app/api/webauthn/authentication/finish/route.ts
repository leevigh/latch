import { NextResponse } from "next/server";
import { verifyAuthenticationResponse } from "@simplewebauthn/server";
import type { AuthenticationResponseJSON } from "@simplewebauthn/types";
import { prisma } from "@/lib/prisma";
import { nowMs } from "@/lib/db";
import { getOrCreateSession } from "@/lib/session";
import {
  getOriginFromClientDataJSON,
  resolveWebauthnFinishVerification,
  WebauthnCeremonyConfigError,
} from "@/lib/webauthn-server";

export const runtime = "nodejs";

type FinishBody = { response: AuthenticationResponseJSON; chromeExtensionId?: string };

export async function POST(request: Request) {
  try {
    const { userId: sessionUserId } = await getOrCreateSession();
    const body = (await request.json()) as FinishBody;
    if (!body?.response) {
      return NextResponse.json({ error: "Missing response" }, { status: 400 });
    }

    const now = nowMs();

    const challengeRow = await prisma.webauthnChallenge.findFirst({
      where: { userId: sessionUserId, purpose: "authentication" },
      orderBy: { createdAt: "desc" },
      select: { id: true, challenge: true, expiresAt: true, rpId: true, origin: true },
    });

    if (!challengeRow || challengeRow.expiresAt <= BigInt(now)) {
      return NextResponse.json({ error: "Authentication challenge expired" }, { status: 400 });
    }

    const clientDataOrigin = getOriginFromClientDataJSON(body.response.response.clientDataJSON);

    let verifyParams: { expectedOrigin: string; expectedRPID: string | string[] };
    try {
      verifyParams = resolveWebauthnFinishVerification({
        challengeOrigin: challengeRow.origin,
        challengeRpId: challengeRow.rpId,
        clientDataOrigin,
        chromeExtensionId: body.chromeExtensionId,
        request,
      });
    } catch (e) {
      if (e instanceof WebauthnCeremonyConfigError) {
        return NextResponse.json({ error: e.message }, { status: 400 });
      }
      throw e;
    }

    const credentialId = body.response.id;
    const cred = await prisma.webauthnCredential.findUnique({
      where: { credentialId },
      select: {
        userId: true,
        credentialId: true,
        credentialIdBytes: true,
        cosePublicKey: true,
        signCount: true,
      },
    });

    if (!cred) {
      return NextResponse.json(
        { error: "No account found for this passkey (unknown credentialId)." },
        { status: 404 }
      );
    }

    const verification = await verifyAuthenticationResponse({
      response: body.response,
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

    if (!verification.verified || !verification.authenticationInfo) {
      return NextResponse.json({ error: "Authentication verification failed" }, { status: 400 });
    }

    const newCounter = verification.authenticationInfo.newCounter;
    await prisma.webauthnCredential.update({
      where: { credentialId },
      data: { signCount: newCounter },
    });

    // Attach this credential to the current session user so "List accounts" works after discoverable login.
    if (cred.userId !== sessionUserId) {
      await prisma.$transaction([
        prisma.webauthnCredential.update({
          where: { credentialId },
          data: { userId: sessionUserId },
        }),
        prisma.smartAccount.updateMany({
          where: { credentialId },
          data: { userId: sessionUserId },
        }),
      ]);
    }

    const acct = await prisma.smartAccount.findUnique({
      where: { credentialId },
      select: { smartAccountAddress: true, deployed: true, keyDataHex: true },
    });

    if (!acct) {
      return NextResponse.json(
        { error: "Credential verified, but no smart account mapping exists." },
        { status: 500 }
      );
    }

    const accounts = await prisma.smartAccount.findMany({
      where: { userId: sessionUserId },
      orderBy: { createdAt: "desc" },
      select: { smartAccountAddress: true, credentialId: true, deployed: true },
    });

    await prisma.webauthnChallenge.delete({ where: { id: challengeRow.id } });

    return NextResponse.json({
      smartAccountAddress: acct.smartAccountAddress,
      keyDataHex: acct.keyDataHex,
      deployed: !!acct.deployed,
      activeCredentialId: credentialId,
      accounts: accounts.map((a) => ({
        smartAccountAddress: a.smartAccountAddress,
        credentialId: a.credentialId,
        deployed: !!a.deployed,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Authentication finish failed" },
      { status: 500 }
    );
  }
}
