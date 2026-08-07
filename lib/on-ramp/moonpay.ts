import "server-only";
import { ApiRequestError } from "@/lib/api-errors";
import { moonPayApiBase, moonPaySecretKey } from "@/lib/on-ramp/config";

type MoonPayErrorBody = {
  code?: string;
  message?: string;
  errors?: Array<{ field?: string; message?: string }>;
};

async function moonPayFetch<T>(
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${moonPayApiBase()}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": moonPaySecretKey(),
      ...(init?.headers ?? {}),
    },
  });

  const data = (await res.json().catch(() => ({}))) as T & MoonPayErrorBody;
  if (!res.ok) {
    const detail =
      data.message ??
      data.errors?.map((e) => e.message).filter(Boolean).join("; ") ??
      `MoonPay request failed (${res.status})`;
    throw new ApiRequestError("moonpay_error", detail, res.status);
  }
  return data;
}

export async function createMoonPaySession(params: {
  externalCustomerId: string;
  deviceIp: string;
}): Promise<{ sessionToken: string }> {
  const data = await moonPayFetch<{ sessionToken: string }>(
    "/platform/v1/sessions",
    {
      method: "POST",
      body: JSON.stringify({
        externalCustomerId: params.externalCustomerId,
        deviceIp: params.deviceIp,
      }),
    }
  );

  if (!data.sessionToken) {
    throw new ApiRequestError(
      "moonpay_error",
      "MoonPay did not return a sessionToken.",
      502
    );
  }

  return { sessionToken: data.sessionToken };
}

export async function getMoonPayTransaction(
  transactionId: string
): Promise<{ data: { id: string; status: string } }> {
  return moonPayFetch<{ data: { id: string; status: string } }>(
    `/platform/v1/transactions/${encodeURIComponent(transactionId)}`
  );
}
