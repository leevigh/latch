#!/usr/bin/env node

/**
 * Full flow test: Smart Account + Verifier + Counter
 *
 * This script simulates the exact flow from the Phantom UI:
 * 1. Generate test Ed25519 keypair
 * 2. Deploy smart account for that keypair
 * 3. Build transaction to call counter through smart account
 * 4. Generate auth payload and sign with test keypair
 * 5. Submit transaction with authorization
 * 6. Log everything at each step
 */

import StellarSdk from "@stellar/stellar-sdk";
import crypto from "crypto";
import nacl from "tweetnacl";
import { execSync } from "child_process";

const {
  Contract,
  rpc,
  TransactionBuilder,
  Networks,
  Address,
  xdr,
  Keypair,
  Operation,
  Account,
} = StellarSdk;

// Config
const VERIFIER_ADDRESS = "CBNCF7QBTMIAEIZ3H6EN6JU5RDLBTFZZKGSWPAXW6PGPNY3HHIW5HKCH";
const COUNTER_ADDRESS = "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U";
const SMART_ACCOUNT_WASM_HASH = "cf67f31cbff555b5a6c1fb3ab4411b9cdf34e96d4d2cf52dbec5d1f13fc6db40";
const RPC_URL = "https://soroban-testnet.stellar.org";
const NETWORK_PASSPHRASE = Networks.TESTNET;
const AUTH_PREFIX = "Stellar Smart Account Auth:\n";
const BUNDLER_SECRET = "SDGWLYMZGV43RKDEQXGD4FKRP3L7S6BC5QQQDS54MJ6RORZSJE64V2PF";

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

function log(section, data) {
  console.log(`\n${"=".repeat(80)}`);
  console.log(`${section}`);
  console.log(`${"=".repeat(80)}`);
  console.log(data);
}

async function testFullFlow() {
  console.log("\n🚀 Full Flow Test: Smart Account + Verifier + Counter\n");

  const server = new rpc.Server(RPC_URL);
  const bundlerKeypair = Keypair.fromSecret(BUNDLER_SECRET);

  // ============================================================================
  // STEP 1: Generate test keypair
  // ============================================================================
  log("STEP 1: Generate Test Ed25519 Keypair", "");
  const seed = crypto.randomBytes(32);
  const testKeypair = nacl.sign.keyPair.fromSeed(seed);
  const publicKeyBytes = testKeypair.publicKey;
  const secretKeyBytes = testKeypair.secretKey;
  const publicKeyHex = bytesToHex(publicKeyBytes);

  console.log(`Public Key (hex): ${publicKeyHex}`);
  console.log(`Public Key (bytes): ${publicKeyBytes.length} bytes`);

  // ============================================================================
  // STEP 2: Deploy smart account
  // ============================================================================
  log("STEP 2: Deploy Smart Account", "");

  const salt = crypto.createHash("sha256").update(publicKeyHex + "v7").digest("hex");
  console.log(`Salt: ${salt}`);

  // Deploy via CLI (simpler than building deploy transaction)
  console.log("\nDeploying smart account...");
  const deployCmd = `stellar contract deploy \
    --wasm-hash ${SMART_ACCOUNT_WASM_HASH} \
    --salt ${salt} \
    --source franky \
    --network testnet \
    -- \
    --admin franky \
    --verifier_address ${VERIFIER_ADDRESS} \
    --key_data ${publicKeyHex}`;

  let smartAccountAddress;
  try {
    smartAccountAddress = execSync(deployCmd, { encoding: "utf-8" }).trim();
    console.log(`Smart Account Address: ${smartAccountAddress}`);
  } catch (e) {
    if (e.stderr && e.stderr.includes("already exists")) {
      // Parse address from error message
      const match = e.stderr.match(/contract (C[A-Z0-9]{55})/);
      if (match) {
        smartAccountAddress = match[1];
        console.log(`Smart Account Already Exists: ${smartAccountAddress}`);
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  // Call initialize to register a context rule for the counter contract
  // Without this, do_check_auth fails with Error(Contract, #3002) = UnvalidatedContext
  // because no context rule matches the counter.increment invocation
  console.log(`\nInitializing smart account with context rule for counter...`);
  const initCmd = `stellar contract invoke \
    --id ${smartAccountAddress} \
    --source franky \
    --network testnet \
    -- \
    initialize \
    --verifier ${VERIFIER_ADDRESS} \
    --public_key ${publicKeyHex} \
    --counter ${COUNTER_ADDRESS}`;

  try {
    execSync(initCmd, { encoding: "utf-8", stdio: "pipe" });
    console.log(`✅ Smart account initialized with counter context rule`);
  } catch (e) {
    // May fail if already initialized - that's ok
    if (e.stderr && (e.stderr.includes("already") || e.stderr.includes("ExistingValue"))) {
      console.log(`ℹ️  Smart account already initialized (context rule exists)`);
    } else {
      console.log(`⚠️  Initialize warning: ${e.stderr?.substring(0, 200) || e.message}`);
    }
  }

  // ============================================================================
  // STEP 3: Build transaction to invoke counter through smart account
  // ============================================================================
  log("STEP 3: Build Transaction", "");

  const contract = new Contract(COUNTER_ADDRESS);
  const smartAccountAddr = Address.fromString(smartAccountAddress);

  // Use BUNDLER account as transaction source (smart accounts don't have sequence numbers)
  const bundlerAccount = await server.getAccount(bundlerKeypair.publicKey());
  console.log(`Bundler Sequence: ${bundlerAccount.sequence}`);
  console.log(`Smart Account Address: ${smartAccountAddress}`);

  // Build invoke operation - counter.increment(caller = smart_account)
  // The smart account will authorize this call via the verifier
  const incrementOp = contract.call(
    "increment",
    smartAccountAddr.toScVal() // caller = smart account
  );

  let tx = new TransactionBuilder(bundlerAccount, {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(incrementOp)
    .setTimeout(300)
    .build();

  console.log(`Transaction Source: ${tx.source}`);
  console.log(`Transaction Fee: ${tx.fee}`);
  console.log(`Transaction Sequence: ${tx.sequence}`);
  console.log(`Operations: ${tx.operations.length}`);

  const txXdr = tx.toXDR();
  console.log(`Transaction XDR Length: ${txXdr.length}`);

  // ============================================================================
  // STEP 4: Simulate to get auth entry
  // ============================================================================
  log("STEP 4: Simulate Transaction", "");

  const simResponse = await server.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(simResponse)) {
    console.error("❌ Simulation failed:", simResponse.error);
    return;
  }

  console.log("✅ Simulation successful");
  console.log(`Min Resource Fee: ${simResponse.minResourceFee}`);
  console.log(`Instructions: ${simResponse.cost?.cpuInsns || 'N/A'}`);
  console.log(`Read Bytes: ${simResponse.cost?.memBytes || 'N/A'}`);

  // Extract auth entry
  if (!simResponse.result?.auth || simResponse.result.auth.length === 0) {
    console.error("❌ No auth entries in simulation result");
    return;
  }

  const authEntry = simResponse.result.auth[0];
  const authEntryXdr = authEntry.toXDR("base64");
  console.log(`Auth Entry XDR Length: ${authEntryXdr.length}`);

  // Parse auth entry to see what we're signing
  const parsedAuthEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");
  const rootInvocation = parsedAuthEntry.rootInvocation();

  console.log("\nAuth Entry extracted successfully");

  // ============================================================================
  // STEP 5: Generate authDigest and sign it
  // ============================================================================
  log("STEP 5: Generate Auth Digest & Sign", "");

  // Set a proper signature expiration ledger (~5 minutes from now)
  // Recording Mode returns signatureExpirationLedger = 0 by default
  const latestLedger = simResponse.latestLedger;
  const expirationLedger = latestLedger + 60;
  console.log(`\nSetting signature expiration: ledger ${expirationLedger} (latest: ${latestLedger}, +60)`);
  parsedAuthEntry.credentials().address().signatureExpirationLedger(expirationLedger);

  // Build soroban auth for hashing (this is what gets signed)
  const hashEntry = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
    new xdr.HashIdPreimageSorobanAuthorization({
      networkId: xdr.Hash.fromXDR(crypto.createHash("sha256").update(NETWORK_PASSPHRASE).digest()),
      nonce: parsedAuthEntry.credentials().address().nonce(),
      signatureExpirationLedger: expirationLedger,
      invocation: rootInvocation,
    })
  );

  const signaturePayload = crypto.createHash("sha256").update(hashEntry.toXDR()).digest();
  const signaturePayloadHex = bytesToHex(signaturePayload);

  // External signers must sign:
  // authDigest = sha256(signaturePayload || context_rule_ids.to_xdr()).
  const ruleIdsXdr = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]).toXDR();
  const authDigest = crypto
    .createHash("sha256")
    .update(Buffer.concat([signaturePayload, Buffer.from(ruleIdsXdr)]))
    .digest();
  const authDigestHex = bytesToHex(authDigest);

  console.log(`Signature Payload (hex): ${signaturePayloadHex}`);
  console.log(`Signature Payload (bytes): ${signaturePayload.length} bytes`);
  console.log(`Auth Digest (hex): ${authDigestHex}`);
  console.log(`Auth Digest (bytes): ${authDigest.length} bytes`);

  // Construct prefixed message (what Phantom signs)
  const prefixedMessage = AUTH_PREFIX + authDigestHex;
  const prefixedMessageBytes = Buffer.from(prefixedMessage, "utf-8");

  console.log(`\nPrefixed Message: "${prefixedMessage}"`);
  console.log(`Prefixed Message Length: ${prefixedMessageBytes.length} bytes`);
  console.log(`Expected Length: 92 bytes (28 prefix + 64 hex)`);

  if (prefixedMessageBytes.length !== 92) {
    console.error(`❌ ERROR: Prefixed message wrong length!`);
    return;
  }

  // Sign the prefixed message
  const signature = nacl.sign.detached(prefixedMessageBytes, secretKeyBytes);
  const signatureHex = bytesToHex(signature);

  console.log(`\nSignature (hex): ${signatureHex}`);
  console.log(`Signature (bytes): ${signature.length} bytes`);

  // ============================================================================
  // STEP 6: Build Ed25519SigData and encode to XDR
  // ============================================================================
  log("STEP 6: Encode Ed25519SigData", "");

  const sigDataMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("prefixed_message"),
      val: xdr.ScVal.scvBytes(prefixedMessageBytes),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signature"),
      val: xdr.ScVal.scvBytes(signature),
    }),
  ]);

  const sigDataXdr = sigDataMap.toXDR();
  const sigDataBytes = xdr.ScVal.scvBytes(sigDataXdr);

  console.log(`Ed25519SigData XDR Size: ${sigDataXdr.length} bytes`);

  // ============================================================================
  // STEP 7: Build signature map for smart account auth
  // ============================================================================
  log("STEP 7: Build Signature Map", "");

  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    Address.fromString(VERIFIER_ADDRESS).toScVal(),
    xdr.ScVal.scvBytes(publicKeyBytes),
  ]);

  const sigInnerMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: signerKey,
      val: sigDataBytes,
    }),
  ]);

  const authPayloadMap = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: sigInnerMap,
    }),
  ]);

  console.log("Signature Map Structure:");
  console.log(`  Signer Type: External`);
  console.log(`  Verifier: ${VERIFIER_ADDRESS}`);
  console.log(`  Public Key: ${publicKeyHex}`);

  // Set signature on auth entry
  const credentials = parsedAuthEntry.credentials().address();
  credentials.signature(authPayloadMap);

  console.log("\n✅ Auth entry signed");

  // ============================================================================
  // STEP 8: Build transaction with signed auth entries
  // ============================================================================
  log("STEP 8: Build Transaction with Signed Auth", "");

  // Build a new transaction that includes the signed auth entry
  const txWithAuth = new TransactionBuilder(new Account(tx.source, (BigInt(tx.sequence) - 1n).toString()), {
    fee: "100000",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.invokeHostFunction({
        func: tx.operations[0].func,
        auth: [parsedAuthEntry],
      })
    )
    .setTimeout(300)
    .build();

  console.log("Transaction built with signed auth entry");

  // ============================================================================
  // STEP 9: Simulate in Enforcing Mode (validates signatures + accurate resources)
  // ============================================================================
  log("STEP 9: Enforcing Mode Simulation", "");

  // This is the KEY step we were previously skipping.
  // Enforcing Mode:
  //   - Executes __check_auth → validates the signature
  //   - Discovers ALL ledger entries (verifier, smart account, etc.) → correct footprint
  //   - Measures actual CPU/memory → correct resource fees
  // No more manual footprint patching or instruction padding!

  const enforcingSim = await server.simulateTransaction(txWithAuth);

  if (rpc.Api.isSimulationError(enforcingSim)) {
    console.error("❌ Enforcing simulation failed:", enforcingSim.error);
    return;
  }

  console.log("✅ Enforcing Mode simulation succeeded!");
  console.log(`   Min Resource Fee: ${enforcingSim.minResourceFee}`);
  console.log(`   Instructions: ${enforcingSim.cost?.cpuInsns || 'N/A'}`);
  console.log(`   Read Bytes: ${enforcingSim.cost?.memBytes || 'N/A'}`);

  // ============================================================================
  // STEP 10: Assemble and sign (SDK handles footprint + fees automatically)
  // ============================================================================
  log("STEP 10: Assemble, Sign & Submit", "");

  const assembledTx = rpc.assembleTransaction(txWithAuth, enforcingSim).build();

  console.log(`  Final Fee: ${assembledTx.fee}`);

  // Sign with bundler (fee-payer)
  assembledTx.sign(bundlerKeypair);
  console.log(`  Signatures: ${assembledTx.signatures.length}`);

  // ============================================================================
  // STEP 11: Submit transaction
  // ============================================================================
  log("STEP 11: Submit Transaction", "");

  const sendResult = await server.sendTransaction(assembledTx);

  if (sendResult.status === "ERROR") {
    console.error("❌ Transaction submission failed:");
    console.error("   Error:", sendResult.errorResult?.toXDR("base64"));
    return;
  }

  const txHash = sendResult.hash;
  console.log(`✅ Transaction submitted: ${txHash}`);
  console.log(`   Explorer: https://stellar.expert/explorer/testnet/tx/${txHash}`);

  // ============================================================================
  // STEP 12: Wait for result
  // ============================================================================
  log("STEP 12: Wait for Result", "");

  let txResult;
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 1000));
    txResult = await server.getTransaction(txHash);

    if (txResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      break;
    }
    process.stdout.write(".");
  }
  console.log();

  // ============================================================================
  // STEP 13: Check result
  // ============================================================================
  log("STEP 13: Final Result", "");

  if (txResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
    const returnValue = txResult.returnValue;
    console.log(`✅ SUCCESS!`);
    console.log(`   Counter returned: ${returnValue?._value || 'N/A'}`);
    console.log(`\n${"🎉".repeat(40)}`);
    console.log("Full flow successful: Smart Account → Verifier → Counter");
    console.log(`${"🎉".repeat(40)}`);
  } else {
    console.log(`❌ Transaction failed: ${txResult.status}`);

    if (txResult.status === rpc.Api.GetTransactionStatus.FAILED) {
      console.log("\n📋 Diagnostic Events:");

      if (txResult.diagnosticEventsXdr) {
        txResult.diagnosticEventsXdr.forEach((event, i) => {
          try {
            const eventObj = event._attributes?.event;
            const eventType = eventObj?._attributes?.type?._switch?.name || 'unknown';
            console.log(`\nEvent ${i} (${eventType}):`);

            if (eventType === 'contract') {
              const body = eventObj._attributes?.body?._value;
              if (body) {
                const topics = body._attributes?.topics?._value || [];
                console.log(`  Topics:`, topics.map(t => {
                  try {
                    return t._switch?.name || JSON.stringify(t).substring(0, 100);
                  } catch {
                    return '[complex]';
                  }
                }));
              }
            }
          } catch (e) {
            console.log(`  [Error parsing event ${i}]`);
          }
        });
      }

      // Parse result XDR
      if (txResult.resultXdr) {
        const parsedResult = txResult.resultXdr;
        const resultCode = parsedResult.result().switch().name;
        console.log(`\nResult Code: ${resultCode}`);

        const opResults = parsedResult.result().results();
        if (opResults && opResults.length > 0) {
          const opResult = opResults[0];
          const opResultCode = opResult.switch().name;
          console.log(`Operation Result: ${opResultCode}`);

          if (opResultCode === "opInner") {
            const innerResult = opResult.value();
            const invokeResult = innerResult.switch().name;
            console.log(`Invoke Result: ${invokeResult}`);
          }
        }
      }
    }
  }
}

// Run test
testFullFlow().catch((e) => {
  console.error("\n❌ Unexpected error:", e);
  process.exit(1);
});
