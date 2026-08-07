#!/usr/bin/env node
/**
 * Smoke test for POST /api/transaction/prepare-sign.
 * Uses build-send output as a reference unsigned XDR source.
 *
 * Usage:
 *   SMART_ACCOUNT_ADDRESS=C... node scripts/test-prepare-sign.mjs
 */

const BASE = process.env.LATCH_API_BASE || "http://localhost:3000";

const smartAccount =
  process.env.SMART_ACCOUNT_ADDRESS ||
  process.argv.find((a) => a.startsWith("C") && a.length > 50);

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  return { res, data };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERT FAILED:", msg);
    process.exit(1);
  }
}

async function main() {
  if (!smartAccount) {
    console.error("Set SMART_ACCOUNT_ADDRESS=C... or pass as arg");
    process.exit(1);
  }

  console.log("Smart account:", smartAccount);
  console.log("API base:", BASE);

  const balRes = await fetch(
    `${BASE}/api/smart-account/balances?smartAccountAddress=${encodeURIComponent(smartAccount)}&all=1`
  );
  const balData = await balRes.json();
  if (!balData.balances?.length) {
    console.log("No balances — fund account before testing.");
    process.exit(0);
  }

  const asset = balData.balances[0];
  const tiny = "0.0000001";

  const { res: buildRes, data: build } = await postJson("/api/transaction/build-send", {
    smartAccountAddress: smartAccount,
    signerType: "phantom",
    assetId: asset.assetId,
    recipient: smartAccount,
    amount: tiny,
  });

  console.log("\nbuild-send:", buildRes.status);
  if (!buildRes.ok) {
    console.log(JSON.stringify(build, null, 2));
    process.exit(1);
  }

  const { res: prepRes, data: prep } = await postJson("/api/transaction/prepare-sign", {
    network: "testnet",
    smartAccountAddress: smartAccount,
    unsignedTxXdr: build.txXdr,
    signerType: "phantom",
  });

  console.log("prepare-sign:", prepRes.status);
  if (!prepRes.ok) {
    console.log(JSON.stringify(prep, null, 2));
    process.exit(1);
  }

  assert(prep.txXdr, "missing txXdr");
  assert(prep.authEntryXdr, "missing authEntryXdr");
  assert(prep.authDigestHex, "missing authDigestHex");
  assert(prep.contextRuleId !== undefined, "missing contextRuleId");
  assert(prep.validUntilLedger, "missing validUntilLedger");
  assert(Array.isArray(prep.operations) && prep.operations.length >= 1, "missing operations");
  assert(prep.estimatedFeeXlm, "missing estimatedFeeXlm");
  assert(prep.operations[0].summary, "missing operation summary");

  console.log("\nprepare-sign OK:");
  console.log("  contextRuleId:", prep.contextRuleId);
  console.log("  authDigestHex:", prep.authDigestHex.slice(0, 16) + "...");
  console.log("  operations[0]:", prep.operations[0].summary);
  console.log("  estimatedFeeXlm:", prep.estimatedFeeXlm);
  console.log("  warnings:", prep.warnings?.length ? prep.warnings : "(none)");

  // Invalid XDR
  const { res: badRes, data: bad } = await postJson("/api/transaction/prepare-sign", {
    network: "testnet",
    smartAccountAddress: smartAccount,
    unsignedTxXdr: "not-valid-xdr",
  });
  assert(badRes.status === 400 && bad.code === "invalid_xdr", "expected invalid_xdr");

  console.log("\nAll prepare-sign checks passed.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
