#!/usr/bin/env node
/**
 * Smoke test for token send APIs (build-send + balances).
 * Requires BUNDLER_SECRET and a funded smart account in .env / env vars.
 *
 * Usage:
 *   SMART_ACCOUNT_ADDRESS=C... node scripts/test-send-flow.mjs
 *   node scripts/test-send-flow.mjs --balances-only
 */

const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org";
const BASE = process.env.LATCH_API_BASE || "http://localhost:3000";

const smartAccount =
  process.env.SMART_ACCOUNT_ADDRESS ||
  process.argv.find((a) => a.startsWith("C") && a.length > 50);

const balancesOnly = process.argv.includes("--balances-only");

async function main() {
  if (!smartAccount) {
    console.error("Set SMART_ACCOUNT_ADDRESS=C... or pass as first arg");
    process.exit(1);
  }

  console.log("Smart account:", smartAccount);
  console.log("API base:", BASE);

  const balRes = await fetch(
    `${BASE}/api/smart-account/balances?smartAccountAddress=${encodeURIComponent(smartAccount)}&all=1`
  );
  const balData = await balRes.json();
  console.log("\nBalances:", balRes.status, JSON.stringify(balData, null, 2));

  if (balancesOnly) return;

  if (!balData.balances?.length) {
    console.log("\nNo balances — fund account before testing build-send.");
    return;
  }

  const asset = balData.balances[0];
  const tiny = "0.0000001";

  const buildRes = await fetch(`${BASE}/api/transaction/build-send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      smartAccountAddress: smartAccount,
      signerType: "phantom",
      assetId: asset.assetId,
      recipient: smartAccount,
      amount: tiny,
    }),
  });
  const build = await buildRes.json();
  console.log("\nbuild-send:", buildRes.status);
  if (buildRes.ok) {
    console.log("  contextRuleId:", build.contextRuleId);
    console.log("  discovery:", build.contextRuleDiscovery);
    console.log("  txXdr length:", build.txXdr?.length);
  } else {
    console.log(JSON.stringify(build, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
