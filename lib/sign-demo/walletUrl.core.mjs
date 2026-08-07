/** @param {string} b64 */
export function toBase64Url(b64) {
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

/** @param {string} b64url */
export function fromBase64Url(b64url) {
  let b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4 !== 0) {
    b64 += "=";
  }
  return b64;
}

/**
 * @param {string} appOrigin
 * @param {import('./walletUrl.core.mjs').WalletSignQuery} params
 */
export function buildHostedWalletSignUrl(appOrigin, params) {
  const url = new URL("/wallet/sign", appOrigin);
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

/** @param {string} appOrigin */
export function callbackUrl(appOrigin) {
  return `${appOrigin.replace(/\/$/, "")}/dev/sign-demo/callback`;
}
