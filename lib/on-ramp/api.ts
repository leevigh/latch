import type {
  CreateOnRampSessionRequest,
  CreateOnRampSessionResponse,
  OnRampIntentResponse,
  PoolSnapshotResponse,
  UpdateOnRampIntentRequest,
} from "./types";

const apiBase = () =>
  (process.env.NEXT_PUBLIC_LATCH_API_URL ?? "").replace(/\/$/, "");

function apiUrl(path: string): string {
  const base = apiBase();
  return base ? `${base}${path}` : path;
}

export class OnRampApiError extends Error {
  code: string;
  status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "OnRampApiError";
    this.code = code;
    this.status = status;
  }
}

async function parseJsonResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg =
      (data as { message?: string; error?: string }).message ??
      (data as { error?: string }).error ??
      `Request failed: ${res.status}`;
    const code = (data as { code?: string }).code ?? "request_failed";
    throw new OnRampApiError(code, msg, res.status);
  }
  return data as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(res);
}

async function patchJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  });
  return parseJsonResponse<T>(res);
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path), { credentials: "include" });
  return parseJsonResponse<T>(res);
}

export async function createOnRampSession(body: CreateOnRampSessionRequest) {
  return postJson<CreateOnRampSessionResponse>("/api/on-ramp/session", body);
}

export async function fetchOnRampIntent(intentId: string) {
  return getJson<OnRampIntentResponse>(
    `/api/on-ramp/intent/${encodeURIComponent(intentId)}`
  );
}

export async function updateOnRampIntent(
  intentId: string,
  body: UpdateOnRampIntentRequest
) {
  return patchJson<OnRampIntentResponse>(
    `/api/on-ramp/intent/${encodeURIComponent(intentId)}`,
    body
  );
}

export async function fetchPoolSnapshot(memoFilter?: string) {
  const query = memoFilter
    ? `?memo=${encodeURIComponent(memoFilter)}`
    : "";
  return getJson<PoolSnapshotResponse>(`/api/on-ramp/pool${query}`);
}
