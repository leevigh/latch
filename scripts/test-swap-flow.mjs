#!/usr/bin/env node
/**
 * Smoke test for swap APIs: setup-swap-rules, build-swap, context-rules.
 * Full submit requires WebAuthn credentials (set KEY_DATA_HEX + run submit manually).
 *
 * Usage:
 *   SMART_ACCOUNT_ADDRESS=C... \
 *   KEY_DATA_HEX=... \
 *   SWAP_CHAIN_XDR=... \
 *   TOKEN_IN_CONTRACT_ID=CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC \
 *   AMOUNT_IN_RAW=1000000 \
 *   AMOUNT_OUT_MIN_RAW=1 \
 *   node scripts/test-swap-flow.mjs
 *
 * Flags:
 *   --setup-only   Only test setup-swap-rules
 *   --build-only   Skip setup (assume rule exists)
 *   --context-only Only test GET context-rules
 */

const BASE = process.env.LATCH_API_BASE || "http://localhost:3000";
const NETWORK = process.env.NETWORK || "testnet";

const ROUTER_TESTNET =
  process.env.ROUTER_CONTRACT_ID ||
  "CBCFTQSPDBAIZ6R6PJQKSQWKNKWH2QIV3I4J72SHWBIK3ADRRAM5A6GD";

const smartAccount =
  process.env.SMART_ACCOUNT_ADDRESS ||
  process.argv.find((a) => a.startsWith("C") && a.length > 50);

const keyDataHex = process.env.KEY_DATA_HEX;
const swapChainXdr = process.env.SWAP_CHAIN_XDR;
const tokenInContractId =
  process.env.TOKEN_IN_CONTRACT_ID ||
  "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
const amountInRaw = process.env.AMOUNT_IN_RAW || "1000000";
const amountOutMinRaw = process.env.AMOUNT_OUT_MIN_RAW || "1";

const setupOnly = process.argv.includes("--setup-only");
const buildOnly = process.argv.includes("--build-only");
const contextOnly = process.argv.includes("--context-only");

async function postJson(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERT FAILED:", msg);
    process.exit(1);
  }
}

async function testContextRules() {
  const url = `${BASE}/api/smart-account/context-rules?address=${encodeURIComponent(smartAccount)}&network=${NETWORK}`;
  const res = await fetch(url);
  const data = await res.json();
  console.log("\nGET context-rules:", res.status);
  console.log(JSON.stringify(data, null, 2));
  assert(res.ok, "context-rules should return 200");
  assert(Array.isArray(data.rules), "rules should be an array");
}

async function testSetupSwapRules() {
  const body = {
    network: NETWORK,
    smartAccountAddress: smartAccount,
    signerType: keyDataHex ? "passkey" : "phantom",
    providerId: "aquarius",
    routerContractId: ROUTER_TESTNET,
  };
  if (keyDataHex) body.keyDataHex = keyDataHex;
  else body.publicKeyHex = process.env.PUBLIC_KEY_HEX || "0".repeat(64);

  const { res, data } = await postJson("/api/smart-account/setup-swap-rules", body);
  console.log("\nsetup-swap-rules:", res.status);
  console.log(JSON.stringify(data, null, 2));
  assert(res.ok || res.status === 200, "setup-swap-rules should succeed");
  if (!data.alreadyConfigured) {
    assert(data.txXdr, "setup should return txXdr when not already configured");
    assert(data.authEntryXdr, "setup should return authEntryXdr");
  }
}

async function testBuildSwap() {
  if (!swapChainXdr) {
    console.log("\nbuild-swap: skipped (set SWAP_CHAIN_XDR from Aquarius find-path quote)");
    return;
  }

  const { res, data } = await postJson("/api/transaction/build-swap", {
    network: NETWORK,
    smartAccountAddress: smartAccount,
    signerType: keyDataHex ? "passkey" : "phantom",
    routerContractId: ROUTER_TESTNET,
    swapChainXdr,
    tokenInContractId,
    amountInRaw,
    amountOutMinRaw,
    providerId: "aquarius",
  });

  console.log("\nbuild-swap:", res.status);
  console.log(JSON.stringify(data, null, 2));

  if (res.status === 409 && data.code === "NO_CONTEXT_RULE") {
    console.log("\nNo swap context rule — run without --build-only to setup first.");
    process.exit(1);
  }

  assert(res.ok, "build-swap should succeed");
  assert(data.txXdr, "build-swap should return txXdr");
  assert(data.authEntryXdr, "build-swap should return authEntryXdr");
  assert(Array.isArray(data.authEntriesXdr), "build-swap should return authEntriesXdr array");
  assert(data.authEntriesXdr.length >= 1, "authEntriesXdr should have at least one entry");
  assert(
    typeof data.delegatedGAuthEntrySynthesized === "boolean",
    "delegatedGAuthEntrySynthesized should be boolean"
  );
  console.log("\nbuild-swap OK:");
  console.log("  contextRuleId:", data.contextRuleId);
  console.log("  smartAccountAuthEntryIndex:", data.smartAccountAuthEntryIndex);
  console.log("  delegatedGAuthEntrySynthesized:", data.delegatedGAuthEntrySynthesized);
  console.log("  authEntriesXdr.length:", data.authEntriesXdr.length);
}

async function main() {
  if (!smartAccount) {
    console.error("Set SMART_ACCOUNT_ADDRESS=C... or pass as arg");
    process.exit(1);
  }

  console.log("Smart account:", smartAccount);
  console.log("API base:", BASE);
  console.log("Network:", NETWORK);

  await testContextRules();
  if (contextOnly) return;

  if (!buildOnly) {
    await testSetupSwapRules();
  }
  if (setupOnly) return;

  await testBuildSwap();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
