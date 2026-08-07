/**
 * @param {string} search
 * @param {string} hash
 */
export function parseCallbackResult(search, hash) {
  const sp = new URLSearchParams(search);
  const hashParams = new URLSearchParams(hash.replace(/^#/, ""));

  const statusRaw = sp.get("status") ?? hashParams.get("status");
  const status =
    statusRaw === "signed" || statusRaw === "rejected" || statusRaw === "error"
      ? statusRaw
      : "error";

  return {
    requestId: sp.get("requestId") ?? hashParams.get("requestId") ?? undefined,
    status,
    txHash: sp.get("txHash") ?? hashParams.get("txHash") ?? undefined,
    network: sp.get("network") ?? hashParams.get("network") ?? undefined,
    code: sp.get("code") ?? hashParams.get("code") ?? undefined,
    message: sp.get("message") ?? hashParams.get("message") ?? undefined,
    signedAuthEntry:
      hashParams.get("signedAuthEntry") ??
      sp.get("signedAuthEntry") ??
      undefined,
    signedTxXdr:
      hashParams.get("signedTxXdr") ?? sp.get("signedTxXdr") ?? undefined,
  };
}

/** @param {string | undefined} network @param {string} txHash */
export function stellarExpertTxUrl(network, txHash) {
  const net = network === "mainnet" ? "public" : "testnet";
  return `https://stellar.expert/explorer/${net}/tx/${txHash}`;
}
