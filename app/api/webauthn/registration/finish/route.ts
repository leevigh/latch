import { NextResponse } from "next/server";
import { verifyRegistrationResponse } from "@simplewebauthn/server";
import type { RegistrationResponseJSON } from "@simplewebauthn/types";
import { prisma } from "@/lib/prisma";
import { nowMs } from "@/lib/db";
import { getOrCreateSession } from "@/lib/session";
import {
  coseEc2ToRawP256Uncompressed,
  fromBase64Url,
  getOriginFromClientDataJSON,
  resolveWebauthnFinishVerification,
  sha256Hex,
  WebauthnCeremonyConfigError,
} from "@/lib/webauthn-server";
import {
  buildWebauthnAccountInitParams,
  deployWebauthnSmartAccount,
  deriveWebauthnSalt,
  getFactoryConfigFromEnv,
  isSorobanContractDeployed,
  predictWebauthnSmartAccountAddress,
} from "@/lib/smart-account-factory-webauthn";
import { rpc } from "@stellar/stellar-sdk";
import * as crypto from "crypto";

export const runtime = "nodejs";

type FinishBody = { response: RegistrationResponseJSON; chromeExtensionId?: string };

export async function POST(request: Request) {
  try {
    const { userId } = await getOrCreateSession();

    const body = (await request.json()) as FinishBody;
    if (!body?.response) {
      return NextResponse.json({ error: "Missing response" }, { status: 400 });
    }

    const now = nowMs();

    const challengeRow = await prisma.webauthnChallenge.findFirst({
      where: { userId, purpose: "registration" },
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
      return NextResponse.json({ error: "Registration challenge expired" }, { status: 400 });
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

    const verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: verifyParams.expectedOrigin,
      expectedRPID: verifyParams.expectedRPID,
      requireUserVerification: false,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return NextResponse.json({ error: "Registration verification failed" }, { status: 400 });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    const credentialId = credential.id;
    const credentialIdBytes = fromBase64Url(credentialId);
    const cosePublicKey = Buffer.from(credential.publicKey);
    const rawPublicKey = coseEc2ToRawP256Uncompressed(cosePublicKey);

    const keyData = Buffer.concat([rawPublicKey, credentialIdBytes]);
    const keyDataHex = keyData.toString("hex");
    const salt = deriveWebauthnSalt(keyDataHex);
    const saltHex = salt.toString("hex");

    const config = getFactoryConfigFromEnv();
    if (!config.bundlerSecret) {
      return NextResponse.json({ error: "BUNDLER_SECRET not set." }, { status: 500 });
    }

    const server = new rpc.Server(config.rpcUrl);
    const params = buildWebauthnAccountInitParams(keyDataHex, salt);

    const predictedAddress = await predictWebauthnSmartAccountAddress({
      server,
      networkPassphrase: config.networkPassphrase,
      factoryAddress: config.factoryAddress,
      params,
    });

    const deployedBefore = await isSorobanContractDeployed(server, predictedAddress);
    const deployResult = await deployWebauthnSmartAccount({
      server,
      networkPassphrase: config.networkPassphrase,
      factoryAddress: config.factoryAddress,
      bundlerSecret: config.bundlerSecret,
      params,
      predictedAddress,
    });

    const deployedAfter = await isSorobanContractDeployed(server, predictedAddress);

    const credExists = await prisma.webauthnCredential.findUnique({
      where: { credentialId },
      select: { id: true, userId: true },
    });

    if (credExists && credExists.userId !== userId) {
      return NextResponse.json(
        { error: "This passkey is already registered to a different user session." },
        { status: 409 }
      );
    }

    const credId = credExists?.id ?? crypto.randomUUID();
    const transports = JSON.stringify(
      credential.transports ?? body.response.response.transports ?? null
    );

    await prisma.webauthnCredential.upsert({
      where: { credentialId },
      create: {
        id: credId,
        userId,
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
        userId,
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

    await prisma.smartAccount.upsert({
      where: { credentialId },
      create: {
        id: crypto.randomUUID(),
        userId,
        credentialId,
        keyDataHex,
        saltHex,
        smartAccountAddress: predictedAddress,
        deployed: deployedAfter ? 1 : 0,
        createdAt: BigInt(now),
      },
      update: {
        userId,
        keyDataHex,
        saltHex,
        smartAccountAddress: predictedAddress,
        deployed: deployedAfter ? 1 : 0,
      },
    });

    await prisma.webauthnChallenge.delete({ where: { id: challengeRow.id } });

    return NextResponse.json({
      credentialId,
      keyDataHex,
      saltHex,
      smartAccountAddress: predictedAddress,
      deployed: deployedAfter,
      alreadyDeployed: deployResult.alreadyDeployed || deployedBefore,
      determinismCheck: {
        keyDataHash: sha256Hex(keyDataHex),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Registration finish failed" },
      { status: 500 }
    );
  }
}
