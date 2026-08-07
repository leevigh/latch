#!/usr/bin/env node
/**
 * Integration test for sign-demo API chain:
 * build-sign-demo → prepare-sign → sign-payload POST/GET + negative cases.
 *
 * Usage:
 *   SMART_ACCOUNT_ADDRESS=C... node scripts/test-sign-demo-api.mjs
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

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
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

  // 1. build-sign-demo (noop)
  const { res: buildRes, data: build } = await postJson(
    "/api/transaction/build-sign-demo",
    {
      network: "testnet",
      smartAccountAddress: smartAccount,
      demoAction: "noop",
    }
  );

  console.log("\nbuild-sign-demo (noop):", buildRes.status);
  if (buildRes.status === 403) {
    console.log("build-sign-demo forbidden in production — run against local dev server.");
    process.exit(1);
  }
  assert(buildRes.ok, `build-sign-demo failed: ${JSON.stringify(build)}`);
  assert(build.unsignedTxXdr, "missing unsignedTxXdr");
  assert(build.description, "missing description");

  const unsignedTxXdr = build.unsignedTxXdr;

  // 2. prepare-sign
  const { res: prepRes, data: prep } = await postJson("/api/transaction/prepare-sign", {
    network: "testnet",
    smartAccountAddress: smartAccount,
    unsignedTxXdr,
    signerType: "phantom",
  });

  console.log("prepare-sign:", prepRes.status);
  assert(prepRes.ok, `prepare-sign failed: ${JSON.stringify(prep)}`);
  assert(prep.operations?.length >= 1, "missing operations");
  assert(prep.authDigestHex, "missing authDigestHex");
  assert(prep.estimatedFeeXlm, "missing estimatedFeeXlm");

  // 3. sign-payload round-trip
  const callback = `${BASE}/dev/sign-demo/callback`;
  const requestId = crypto.randomUUID();
  const { res: storeRes, data: stored } = await postJson("/api/sign-payload", {
    network: "testnet",
    smartAccountAddress: smartAccount,
    unsignedTxXdr,
    callback,
    requestId,
    origin: BASE,
    submit: false,
  });

  console.log("sign-payload POST:", storeRes.status);
  assert(storeRes.status === 201, `sign-payload POST failed: ${JSON.stringify(stored)}`);
  assert(stored.payloadRef?.startsWith("sp_"), "invalid payloadRef");

  const { res: getRes, data: fetched } = await getJson(
    `/api/sign-payload/${encodeURIComponent(stored.payloadRef)}`
  );
  console.log("sign-payload GET:", getRes.status);
  assert(getRes.ok, `sign-payload GET failed: ${JSON.stringify(fetched)}`);
  assert(
    fetched.unsignedTxXdr === unsignedTxXdr,
    "fetched XDR does not match stored XDR"
  );

  // 4. Negative: account_mismatch
  const { res: mismatchRes, data: mismatch } = await postJson(
    "/api/transaction/prepare-sign",
    {
      network: "testnet",
      smartAccountAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      unsignedTxXdr,
    }
  );
  assert(
    mismatchRes.status === 400 && mismatch.code === "account_mismatch",
    `expected account_mismatch, got ${mismatchRes.status} ${mismatch.code}`
  );

  // 5. Negative: invalid_xdr
  const { res: badXdrRes, data: badXdr } = await postJson(
    "/api/transaction/prepare-sign",
    {
      network: "testnet",
      smartAccountAddress: smartAccount,
      unsignedTxXdr: "not-valid-xdr",
    }
  );
  assert(
    badXdrRes.status === 400 && badXdr.code === "invalid_xdr",
    `expected invalid_xdr, got ${badXdrRes.status} ${badXdr.code}`
  );

  // 6. Negative: validation_error (missing fields)
  const { res: valRes, data: val } = await postJson("/api/sign-payload", {
    network: "testnet",
  });
  assert(
    valRes.status === 400 && val.code === "validation_error",
    `expected validation_error, got ${valRes.status} ${val.code}`
  );

  // 7. Optional: transfer build
  const { res: xferRes, data: xfer } = await postJson(
    "/api/transaction/build-sign-demo",
    {
      network: "testnet",
      smartAccountAddress: smartAccount,
      demoAction: "transfer",
      recipient: smartAccount,
      amount: "0.0000001",
      assetId: "native",
    }
  );
  if (xferRes.ok) {
    console.log("build-sign-demo (transfer): OK —", xfer.description);
  } else {
    console.log(
      "build-sign-demo (transfer): skipped —",
      xfer.code ?? xfer.message ?? xferRes.status
    );
  }

  console.log("\nSign-demo API integration checks passed.");
  console.log("  operation:", prep.operations[0].summary);
  console.log("  payloadRef:", stored.payloadRef);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
