import type {
  BuildSignDemoRequest,
  BuildSignDemoResponse,
  BuildSendRemoteRequest,
  BuildSendRemoteResponse,
  PrepareSignRequest,
  PrepareSignResponse,
  SignPayloadStoreRequest,
  SignPayloadStoreResponse,
  Network,
} from "./types";

const DEFAULT_GO_API_BASE = "https://latch-backend.onrender.com";

const apiBase = () =>
  (process.env.NEXT_PUBLIC_LATCH_API_URL ?? "").replace(/\/$/, "");

export function goApiBase(): string {
  return (process.env.NEXT_PUBLIC_LATCH_API_URL ?? DEFAULT_GO_API_BASE).replace(
    /\/$/,
    ""
  );
}

function apiUrl(path: string): string {
  const base = apiBase();
  return base ? `${base}${path}` : path;
}

export class SignDemoApiError extends Error {
  code: string;
  status: number;
  suggestedAction?: string;

  constructor(
    code: string,
    message: string,
    status: number,
    suggestedAction?: string
  ) {
    super(message);
    this.name = "SignDemoApiError";
    this.code = code;
    this.status = status;
    this.suggestedAction = suggestedAction;
  }
}

/** Duck-type safe across HMR / duplicate module copies of this class. */
export function isSignDemoApiError(e: unknown): e is SignDemoApiError {
  if (e instanceof SignDemoApiError) return true;
  if (!e || typeof e !== "object") return false;
  const o = e as Record<string, unknown>;
  return (
    o.name === "SignDemoApiError" &&
    typeof o.code === "string" &&
    typeof o.status === "number" &&
    typeof o.message === "string"
  );
}

async function postJson<T>(path: string, body: unknown, baseUrl?: string): Promise<T> {
  const url = baseUrl ? `${baseUrl.replace(/\/$/, "")}${path}` : apiUrl(path);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data as { message?: string; error?: string }).message ??
      (data as { error?: string }).error ??
      `Request failed: ${res.status}`;
    const code = (data as { code?: string }).code ?? "request_failed";
    const suggestedAction = (data as { suggestedAction?: string }).suggestedAction;
    throw new SignDemoApiError(code, msg, res.status, suggestedAction);
  }
  return data as T;
}

export async function buildSignDemo(body: BuildSignDemoRequest) {
  return postJson<BuildSignDemoResponse>("/api/transaction/build-sign-demo", body);
}

/** Go / Render production send builder (Section B2). */
export async function buildSendRemote(
  body: BuildSendRemoteRequest,
  baseUrl: string = goApiBase()
) {
  return postJson<BuildSendRemoteResponse>(
    "/api/transaction/build-send",
    body,
    baseUrl
  );
}

export async function prepareSign(body: PrepareSignRequest) {
  return postJson<PrepareSignResponse>("/api/transaction/prepare-sign", body);
}

export async function storeSignPayload(body: SignPayloadStoreRequest) {
  return postJson<SignPayloadStoreResponse>("/api/sign-payload", body);
}

export async function fetchSignPayload(payloadRef: string) {
  const res = await fetch(apiUrl(`/api/sign-payload/${encodeURIComponent(payloadRef)}`));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data as { message?: string; error?: string }).message ??
      (data as { error?: string }).error ??
      `HTTP ${res.status}`;
    const code = (data as { code?: string }).code ?? "request_failed";
    throw new SignDemoApiError(code, msg, res.status);
  }
  return data as SignPayloadStoreRequest;
}

/**
 * Fallback: when the wallet returns a signed transaction envelope but not a txHash,
 * submit the signed XDR directly to the configured Soroban RPC.
 */
export async function submitTransaction(args: {
  network: Network;
  signedTxXdr: string;
}): Promise<{ txHash: string }> {
  const { resolveNetwork } = await import("@/lib/network");
  const { TransactionBuilder, rpc } = await import("@stellar/stellar-sdk");

  const { rpcUrl, networkPassphrase } = resolveNetwork(args.network);
  const server = new rpc.Server(rpcUrl);
  const tx = TransactionBuilder.fromXDR(args.signedTxXdr, networkPassphrase);

  const sendRes = await server.sendTransaction(tx as any);
  const hash =
    (sendRes as any)?.hash ??
    (sendRes as any)?.transactionHash ??
    (sendRes as any)?.txHash ??
    null;

  if (typeof hash !== "string" || !hash) {
    throw new Error("Transaction submitted but no tx hash returned.");
  }
  return { txHash: hash };
}
