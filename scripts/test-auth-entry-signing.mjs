#!/usr/bin/env node

/**
 * Test auth-entry signing flow following the official Stellar guide
 *
 * This implements Method 2: Auth-entry signing
 * https://developers.stellar.org/docs/learn/encyclopedia/security/signatures-multisig#method-2-auth-entry-signing
 *
 * Flow:
 * 1. Client builds transaction and simulates (Recording Mode)
 * 2. Client signs auth entries
 * 3. Client re-simulates (Enforcing Mode) to validate
 * 4. Client sends XDR to fee-payer
 * 5. Fee-payer rebuilds with its own account as source
 * 6. Fee-payer simulates (Enforcing Mode) for accurate resources
 * 7. Fee-payer signs envelope and submits
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
  StrKey,
  nativeToScVal,
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

const server = new rpc.Server(RPC_URL);

function bytesToHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

console.log("\n🚀 Auth-Entry Signing Flow Test\n");
console.log("Following: https://developers.stellar.org/docs/learn/encyclopedia/security/signatures-multisig\n");

// =============================================================================
// STEP 1: CLIENT - Deploy smart account and build transaction
// =============================================================================
console.log("=".repeat(80));
console.log("CLIENT: Deploy Smart Account & Build Transaction");
console.log("=".repeat(80));

// Generate test keypair (this would be Phantom wallet)
const seed = crypto.randomBytes(32);
const clientKeypair = nacl.sign.keyPair.fromSeed(seed);
const publicKeyHex = bytesToHex(clientKeypair.publicKey);

console.log(`\nClient Public Key: ${publicKeyHex}`);

// Deploy smart account
const salt = crypto.createHash("sha256").update(publicKeyHex + "v6").digest("hex");
console.log(`\nDeploying smart account with salt: ${salt.substring(0, 16)}...`);

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
} catch (e) {
  if (e.stderr && e.stderr.includes("already exists")) {
    const match = e.stderr.match(/contract (C[A-Z0-9]{55})/);
    if (match) smartAccountAddress = match[1];
  } else {
    throw e;
  }
}

console.log(`Smart Account: ${smartAccountAddress}`);

// Build transaction (using bundler as source for now, will be replaced by fee-payer)
const bundlerKeypair = Keypair.fromSecret(BUNDLER_SECRET);
const bundlerAccount = await server.getAccount(bundlerKeypair.publicKey());

const contract = new Contract(COUNTER_ADDRESS);
const operation = contract.call(
  "increment",
  nativeToScVal(smartAccountAddress, { type: "address" })
);

const clientTx = new TransactionBuilder(bundlerAccount, {
  fee: "100000",
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(operation)
  .setTimeout(300)
  .build();

console.log(`\nTransaction built (source: bundler for simulation)`);

// =============================================================================
// STEP 2: CLIENT - Simulate (Recording Mode) to get auth entries
// =============================================================================
console.log("\n" + "=".repeat(80));
console.log("CLIENT: Simulate (Recording Mode)");
console.log("=".repeat(80));

const recordingSim = await server.simulateTransaction(clientTx);

if (rpc.Api.isSimulationError(recordingSim)) {
  console.error("❌ Recording simulation failed:", recordingSim.error);
  process.exit(1);
}

console.log("\n✅ Recording Mode simulation succeeded");
console.log(`   Auth entries to sign: ${recordingSim.result.auth?.length || 0}`);

if (!recordingSim.result.auth || recordingSim.result.auth.length === 0) {
  console.error("❌ No auth entries returned");
  process.exit(1);
}

const authEntry = recordingSim.result.auth[0];

// =============================================================================
// STEP 3: CLIENT - Sign auth entries
// =============================================================================
console.log("\n" + "=".repeat(80));
console.log("CLIENT: Sign Auth Entries");
console.log("=".repeat(80));

const parsedAuthEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntry.toXDR("base64"), "base64");
const rootInvocation = parsedAuthEntry.rootInvocation();

// Build signaturePayload (Soroban auth payload hash)
const hashEntry = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
  new xdr.HashIdPreimageSorobanAuthorization({
    networkId: xdr.Hash.fromXDR(crypto.createHash("sha256").update(NETWORK_PASSPHRASE).digest()),
    nonce: parsedAuthEntry.credentials().address().nonce(),
    signatureExpirationLedger: parsedAuthEntry.credentials().address().signatureExpirationLedger(),
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

console.log(`\nSignature Payload: ${signaturePayloadHex}`);
console.log(`Auth Digest: ${authDigestHex}`);

// Construct prefixed message and sign (Phantom wallet would do this)
const prefixedMessage = AUTH_PREFIX + authDigestHex;
const prefixedMessageBytes = Buffer.from(prefixedMessage, "utf-8");
const signature = nacl.sign.detached(prefixedMessageBytes, clientKeypair.secretKey);

console.log(`Prefixed Message Length: ${prefixedMessageBytes.length} bytes`);
console.log(`Signature: ${bytesToHex(signature).substring(0, 32)}...`);

// Build Ed25519SigData
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

const sigDataBytes = xdr.ScVal.scvBytes(sigDataMap.toXDR());

// Build signature map
const verifierBytes = StrKey.decodeContract(VERIFIER_ADDRESS);
const verifierScAddress = xdr.ScAddress.scAddressTypeContract(verifierBytes);

const signerKey = xdr.ScVal.scvVec([
  xdr.ScVal.scvSymbol("External"),
  xdr.ScVal.scvAddress(verifierScAddress),
  xdr.ScVal.scvBytes(clientKeypair.publicKey),
]);

const sigInnerMap = xdr.ScVal.scvMap([
  new xdr.ScMapEntry({
    key: signerKey,
    val: sigDataBytes,
  }),
]);

// Set signature on auth entry
const credentials = parsedAuthEntry.credentials().address();
credentials.signature(xdr.ScVal.scvVec([sigInnerMap]));

console.log("\n✅ Auth entry signed");

// =============================================================================
// STEP 4: CLIENT - Build transaction XDR to send to fee-payer
// =============================================================================
console.log("\n" + "=".repeat(80));
console.log("CLIENT: Build Transaction XDR for Fee-Payer");
console.log("=".repeat(80));

// Build transaction with signed auth (still using bundler as source for now)
const txWithAuth = new TransactionBuilder(bundlerAccount, {
  fee: "100000",
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .addOperation(
    Operation.invokeHostFunction({
      func: clientTx.operations[0].func,
      auth: [parsedAuthEntry],
    })
  )
  .setTimeout(300)
  .build();

const clientTxXdr = txWithAuth.toXDR();

console.log(`\nTransaction XDR length: ${clientTxXdr.length} characters`);
console.log("\n✅ Client sends transaction XDR to fee-payer");

// =============================================================================
// STEP 5: FEE-PAYER - Parse and rebuild transaction
// =============================================================================
console.log("\n" + "=".repeat(80));
console.log("FEE-PAYER: Rebuild Transaction");
console.log("=".repeat(80));

// Parse client's transaction
const clientTransaction = TransactionBuilder.fromXDR(clientTxXdr, NETWORK_PASSPHRASE);
const invokeOp = clientTransaction.operations[0];

console.log(`\nReceived transaction from client`);
console.log(`  Operations: ${clientTransaction.operations.length}`);

// Rebuild with fee-payer as source (fresh account fetch)
const feePayerAccount = await server.getAccount(bundlerKeypair.publicKey());

const rebuiltTx = new TransactionBuilder(feePayerAccount, {
  fee: clientTransaction.fee,
  networkPassphrase: NETWORK_PASSPHRASE,
})
  .setTimeout(30)
  .addOperation(
    Operation.invokeHostFunction({
      func: invokeOp.func,
      auth: invokeOp.auth || [],
      source: invokeOp.source,
    })
  )
  .build();

console.log(`\n✅ Transaction rebuilt with fee-payer as source`);

// =============================================================================
// STEP 6: FEE-PAYER - Simulate (Enforcing Mode)
// =============================================================================
console.log("\n" + "=".repeat(80));
console.log("FEE-PAYER: Simulate (Enforcing Mode)");
console.log("=".repeat(80));

const enforcingSim = await server.simulateTransaction(rebuiltTx);

if (rpc.Api.isSimulationError(enforcingSim)) {
  console.error("\n❌ Enforcing simulation failed:", enforcingSim.error);
  process.exit(1);
}

console.log("\n✅ Enforcing Mode simulation succeeded");
console.log(`   Min Resource Fee: ${enforcingSim.minResourceFee}`);

// =============================================================================
// STEP 7: FEE-PAYER - Assemble transaction
// =============================================================================
console.log("\n" + "=".repeat(80));
console.log("FEE-PAYER: Assemble Transaction");
console.log("=".repeat(80));

const assembledTx = rpc.assembleTransaction(rebuiltTx, enforcingSim).build();

console.log(`\n✅ Transaction assembled`);
console.log(`   Final Fee: ${assembledTx.fee}`);

// =============================================================================
// STEP 8: FEE-PAYER - Sign and submit
// =============================================================================
console.log("\n" + "=".repeat(80));
console.log("FEE-PAYER: Sign & Submit");
console.log("=".repeat(80));

assembledTx.sign(bundlerKeypair);

console.log(`\nTransaction signed by fee-payer`);
console.log(`Submitting...`);

const sendResult = await server.sendTransaction(assembledTx);

if (sendResult.status === "ERROR") {
  console.error("\n❌ Submission failed:", sendResult.errorResult?.toXDR("base64"));
  process.exit(1);
}

console.log(`\n✅ Transaction submitted: ${sendResult.hash}`);
console.log(`   Explorer: https://stellar.expert/explorer/testnet/tx/${sendResult.hash}`);

// =============================================================================
// STEP 9: Wait for result
// =============================================================================
console.log("\n" + "=".repeat(80));
console.log("Waiting for Result");
console.log("=".repeat(80));

let txResult;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 1000));
  txResult = await server.getTransaction(sendResult.hash);

  if (txResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
    break;
  }
  process.stdout.write(".");
}
console.log();

if (txResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
  console.log("\n🎉 SUCCESS!");
  console.log(`   Counter returned: ${txResult.returnValue?._value || 'N/A'}`);
  console.log("\n" + "=".repeat(80));
  console.log("✅ Full Auth-Entry Signing Flow Successful!");
  console.log("=".repeat(80));
} else {
  console.log(`\n❌ Transaction failed: ${txResult.status}`);

  if (txResult.status === rpc.Api.GetTransactionStatus.FAILED) {
    console.log("\nDiagnostic Events:");
    if (txResult.diagnosticEventsXdr) {
      txResult.diagnosticEventsXdr.forEach((event, i) => {
        console.log(`  Event ${i}:`, event);
      });
    }
  }
}
