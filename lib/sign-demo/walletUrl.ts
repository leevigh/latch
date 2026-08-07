import type { Network } from "./types";
import {
  buildHostedWalletSignUrl as buildHostedWalletSignUrlCore,
  callbackUrl as callbackUrlCore,
  fromBase64Url as fromBase64UrlCore,
  toBase64Url as toBase64UrlCore,
} from "./walletUrl.core.mjs";

export const toBase64Url = toBase64UrlCore;
export const fromBase64Url = fromBase64UrlCore;
export const buildHostedWalletSignUrl = buildHostedWalletSignUrlCore;
export const callbackUrl = callbackUrlCore;

export interface WalletSignQuery {
  network: Network;
  account: string;
  callback: string;
  requestId: string;
  submit?: boolean;
  origin?: string;
  xdr?: string;
  payloadRef?: string;
}

/** Direct extension tab URL (Layer 2 — bypass launcher if you have extension ID) */
export function buildExtensionSignUrl(
  extensionId: string,
  params: WalletSignQuery
): string {
  const url = new URL(`chrome-extension://${extensionId}/tabs/sign-request.html`);
  url.searchParams.set("network", params.network);
  url.searchParams.set("account", params.account);
  url.searchParams.set("callback", params.callback);
  url.searchParams.set("requestId", params.requestId);
  if (params.submit !== undefined) {
    url.searchParams.set("submit", String(params.submit));
  }
  if (params.origin) url.searchParams.set("origin", params.origin);
  if (params.xdr) url.searchParams.set("xdr", params.xdr);
  if (params.payloadRef) url.searchParams.set("payloadRef", params.payloadRef);
  return url.toString();
}

export function newRequestId(): string {
  return crypto.randomUUID();
}

export function appOrigin(): string {
  if (typeof window !== "undefined") {
    return window.location.origin;
  }
  return (
    process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "http://localhost:3000"
  );
}
