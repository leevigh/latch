#!/usr/bin/env node
/**
 * Extended prepare-sign checks including freighter delegated path.
 *
 * Usage:
 *   SMART_ACCOUNT_ADDRESS=C... SIGNER_G=G... node scripts/test-prepare-sign-extended.mjs
 */

const BASE = process.env.LATCH_API_BASE || "http://localhost:3000";

const smartAccount =
  process.env.SMART_ACCOUNT_ADDRESS ||
  process.argv.find((a) => a.startsWith("C") && a.length > 50);

const signerG =
  process.env.SIGNER_G ||
  process.argv.find((a) => a.startsWith("G") && a.length > 50);

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
    console.error("Set SMART_ACCOUNT_ADDRESS=C...");
    process.exit(1);
  }

  const balRes = await fetch(
    `${BASE}/api/smart-account/balances?smartAccountAddress=${encodeURIComponent(smartAccount)}&all=1`
  );
  const balData = await balRes.json();
  if (!balData.balances?.length) {
    console.log("No balances — skipping.");
    process.exit(0);
  }

  const asset = balData.balances[0];
  const { res: buildRes, data: build } = await postJson("/api/transaction/build-send", {
    smartAccountAddress: smartAccount,
    signerType: signerG ? "freighter" : "phantom",
    signerG,
    assetId: asset.assetId,
    recipient: smartAccount,
    amount: "0.0000001",
  });

  assert(buildRes.ok, `build-send failed: ${JSON.stringify(build)}`);

  const prepBody = {
    network: "testnet",
    smartAccountAddress: smartAccount,
    unsignedTxXdr: build.txXdr,
    signerType: signerG ? "freighter" : "phantom",
    ...(signerG ? { signerG } : {}),
  };

  const { res: prepRes, data: prep } = await postJson(
    "/api/transaction/prepare-sign",
    prepBody
  );

  assert(prepRes.ok, `prepare-sign failed: ${JSON.stringify(prep)}`);
  assert(prep.txXdr && prep.authEntryXdr && prep.authDigestHex, "missing core fields");
  assert(prep.operations?.length >= 1, "missing operations");
  assert(prep.estimatedFeeXlm, "missing estimatedFeeXlm");

  if (signerG) {
    assert(prep.gAddressEntryTemplateXdr, "missing gAddressEntryTemplateXdr for freighter");
    assert(prep.smartAccountAuthEntryXdr, "missing smartAccountAuthEntryXdr for freighter");
    console.log("Freighter delegated path: OK");
  }

  // Wrong account
  const { res: mismatchRes, data: mismatch } = await postJson(
    "/api/transaction/prepare-sign",
    {
      network: "testnet",
      smartAccountAddress: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      unsignedTxXdr: build.txXdr,
    }
  );
  assert(
    mismatchRes.status === 400 && mismatch.code === "account_mismatch",
    "expected account_mismatch"
  );

  // prepare-sign output compatible with submit shape (field presence)
  assert(prep.contextRuleId !== undefined, "missing contextRuleId for submit");
  assert(prep.validUntilLedger, "missing validUntilLedger");

  // Admin / self-invoke: setup-send-rules tx must prepare under Default (not CallContract).
  const setupBody = {
    smartAccountAddress: smartAccount,
    signerType: signerG ? "freighter" : "phantom",
    assetId: asset.assetId,
    ...(signerG ? { gAddress: signerG } : {}),
  };
  const { res: setupRes, data: setup } = await postJson(
    "/api/smart-account/setup-send-rules",
    setupBody
  );
  console.log("setup-send-rules:", setupRes.status);
  assert(setupRes.ok, `setup-send-rules failed: ${JSON.stringify(setup)}`);
  if (setup.alreadyConfigured) {
    console.log("setup alreadyConfigured — skipping admin prepare-sign check");
  } else {
    assert(typeof setup.txXdr === "string", "setup missing txXdr");
    const { res: adminPrepRes, data: adminPrep } = await postJson(
      "/api/transaction/prepare-sign",
      {
        network: "testnet",
        smartAccountAddress: smartAccount,
        unsignedTxXdr: setup.txXdr,
        signerType: signerG ? "freighter" : "phantom",
        ...(signerG ? { signerG } : {}),
      }
    );
    console.log("prepare-sign (admin setup tx):", adminPrepRes.status);
    assert(
      adminPrepRes.ok,
      `prepare-sign admin self-invoke failed: ${JSON.stringify(adminPrep)}`
    );
    assert(adminPrep.authEntryXdr, "admin prepare missing authEntryXdr");
  }

  console.log("Extended prepare-sign checks passed.");
  console.log("  operation:", prep.operations[0].summary);
  console.log("  contextRuleId:", prep.contextRuleId);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
