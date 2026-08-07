import * as crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { ApiRequestError } from "@/lib/api-errors";

export type SignPayloadBody = {
  network: string;
  smartAccountAddress: string;
  unsignedTxXdr: string;
  callback: string;
  requestId?: string;
  origin?: string;
  submit?: boolean;
};

const DEFAULT_TTL_SECONDS = 600;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 3600;

export function validateCallbackUrl(callback: string): void {
  let parsed: URL;
  try {
    parsed = new URL(callback);
  } catch {
    throw new ApiRequestError("validation_error", "callback must be a valid URL.");
  }

  const protocol = parsed.protocol.toLowerCase();
  if (protocol === "https:") return;

  if (protocol === "http:") {
    const host = parsed.hostname.toLowerCase();
    if (host === "localhost" || host === "127.0.0.1") return;
  }

  throw new ApiRequestError(
    "validation_error",
    "callback must use https:// or http://localhost / http://127.0.0.1."
  );
}

function generatePayloadRef(): string {
  return `sp_${crypto.randomBytes(16).toString("hex")}`;
}

export async function createSignPayload(
  body: SignPayloadBody,
  ttlSeconds?: number
): Promise<{ payloadRef: string; expiresAt: string }> {
  validateCallbackUrl(body.callback);

  const ttl = Math.min(
    MAX_TTL_SECONDS,
    Math.max(MIN_TTL_SECONDS, ttlSeconds ?? DEFAULT_TTL_SECONDS)
  );
  const expiresAt = new Date(Date.now() + ttl * 1000);
  const payloadRef = generatePayloadRef();

  const payload = {
    network: body.network,
    smartAccountAddress: body.smartAccountAddress,
    unsignedTxXdr: body.unsignedTxXdr,
    callback: body.callback,
    ...(body.requestId ? { requestId: body.requestId } : {}),
    ...(body.origin ? { origin: body.origin } : {}),
    submit: body.submit ?? true,
  };

  await prisma.signPayload.create({
    data: {
      id: payloadRef,
      payload,
      expiresAt,
    },
  });

  return { payloadRef, expiresAt: expiresAt.toISOString() };
}

export async function getSignPayload(payloadRef: string): Promise<SignPayloadBody> {
  const row = await prisma.signPayload.findUnique({ where: { id: payloadRef } });

  if (!row || row.consumedAt) {
    throw new ApiRequestError("not_found", "Payload reference not found.", 404);
  }

  if (row.expiresAt.getTime() <= Date.now()) {
    throw new ApiRequestError("expired", "Payload reference has expired.", 410);
  }

  await prisma.signPayload.update({
    where: { id: payloadRef },
    data: { consumedAt: new Date() },
  });

  return row.payload as SignPayloadBody;
}
