import { NextRequest, NextResponse } from "next/server";
import {
  TransactionBuilder,
  Networks,
  Address,
  xdr,
  rpc,
  Transaction,
  Operation,
  Keypair,
  hash,
} from "@stellar/stellar-sdk";
import { hashSorobanAuthPayload } from "@/lib/soroban-auth-payload";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  verifierAddress: process.env.NEXT_PUBLIC_FREIGHTER_VERIFIER_ADDRESS,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

/**
 * Freighter signing scheme verifier (on-chain) is expected to validate an Ed25519 signature over:
 *   sha256("Stellar Signed Message:\n" + authDigestHex)
 *
 * This route:
 * - Recomputes authDigestHex from the auth entry to ensure the client signed the right thing
 * - Injects Signatures payload pointing at the Freighter-specific verifier
 * - Runs Enforcing Mode simulation + assembles + fee-payer signs + submits
 */
export async function POST(request: NextRequest) {
  const TESTNET_CONFIG = getConfig();

  if (!TESTNET_CONFIG.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set in environment variables." }, { status: 500 });
  }
  if (!TESTNET_CONFIG.verifierAddress) {
    return NextResponse.json({ error: "NEXT_PUBLIC_FREIGHTER_VERIFIER_ADDRESS is not set." }, { status: 500 });
  }

  try {
    const server = new rpc.Server(TESTNET_CONFIG.rpcUrl);
    const {
      txXdr,
      authEntryXdr,
      publicKeyHex,
      message, // should be authDigestHex (lowercase)
      signedMessageBase64, // base64 Ed25519 signature returned by Freighter signMessage
    } = await request.json();

    if (!txXdr || !authEntryXdr || !publicKeyHex || !message || !signedMessageBase64) {
      return NextResponse.json({ error: "Missing required parameters" }, { status: 400 });
    }

    const normalizedMsg = String(message).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(normalizedMsg)) {
      return NextResponse.json({ error: "message must be 64 lowercase hex chars (authDigestHex)" }, { status: 400 });
    }
    if (!/^[0-9a-f]{64}$/.test(String(publicKeyHex))) {
      return NextResponse.json({ error: "publicKeyHex must be 64 hex chars (32-byte Ed25519 public key)" }, { status: 400 });
    }

    const signatureBytes = Buffer.from(String(signedMessageBase64), "base64");
    if (signatureBytes.length !== 64) {
      return NextResponse.json({ error: `signedMessageBase64 must decode to 64 bytes (got ${signatureBytes.length})` }, { status: 400 });
    }

    const tx = TransactionBuilder.fromXDR(txXdr, TESTNET_CONFIG.networkPassphrase) as Transaction;
    const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");

    // Recompute authDigestHex = sha256(signaturePayload || context_rule_ids.to_xdr()).
    const signaturePayload = hashSorobanAuthPayload(authEntry, TESTNET_CONFIG.networkPassphrase);
    const ruleIdsXdr = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]).toXDR();
    const authDigestHex = hash(Buffer.concat([signaturePayload, Buffer.from(ruleIdsXdr)])).toString("hex");

    if (normalizedMsg !== authDigestHex) {
      return NextResponse.json(
        { error: `Signed message does not match recomputed authDigestHex. signed=${normalizedMsg} expected=${authDigestHex}` },
        { status: 400 }
      );
    }

    const pkBytes = Buffer.from(String(publicKeyHex), "hex");
    if (pkBytes.length !== 32) {
      return NextResponse.json({ error: `publicKeyHex must decode to 32 bytes (got ${pkBytes.length})` }, { status: 400 });
    }

    const signerKey = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("External"),
      Address.fromString(TESTNET_CONFIG.verifierAddress).toScVal(),
      xdr.ScVal.scvBytes(pkBytes),
    ]);

    const signaturesScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("context_rule_ids"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signers"),
        val: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: signerKey,
            // For this verifier, sig_data is just the raw 64-byte signature.
            val: xdr.ScVal.scvBytes(signatureBytes),
          }),
        ]),
      }),
    ]);

    authEntry.credentials().address().signature(signaturesScVal);

    const env = tx.toEnvelope();
    if (env.switch().name !== "envelopeTypeTx") {
      return NextResponse.json({ error: "Expected a v1 transaction envelope" }, { status: 400 });
    }
    const txExt = env.v1().tx().ext();
    if (txExt.switch() === 0) {
      return NextResponse.json(
        { error: "Transaction is missing Soroban resource data. Call /api/transaction/build again." },
        { status: 400 }
      );
    }
    const sorobanData = txExt.value() as xdr.SorobanTransactionData;

    const origOp = tx.operations[0] as Operation.InvokeHostFunction;
    const tb = TransactionBuilder.cloneFrom(tx, {
      fee: tx.fee,
      sorobanData,
      networkPassphrase: TESTNET_CONFIG.networkPassphrase,
    });
    tb.clearOperations();
    tb.addOperation(
      Operation.invokeHostFunction({
        source: origOp.source,
        func: origOp.func,
        auth: [authEntry],
      })
    );
    const txWithAuth = tb.build();

    const enforcingSim = await server.simulateTransaction(txWithAuth);
    if (rpc.Api.isSimulationError(enforcingSim)) {
      return NextResponse.json({ error: `Auth validation failed: ${enforcingSim.error}`, authDigestHex }, { status: 400 });
    }

    const assembledTx = rpc.assembleTransaction(txWithAuth, enforcingSim).build();
    const bundlerKeypair = Keypair.fromSecret(TESTNET_CONFIG.bundlerSecret);
    assembledTx.sign(bundlerKeypair);

    const sendResult = await server.sendTransaction(assembledTx);
    if (sendResult.status === "ERROR") {
      throw new Error(`Transaction submission failed: ${sendResult.errorResult?.toXDR("base64")}`);
    }

    const txHash = sendResult.hash;
    let txResult: rpc.Api.GetTransactionResponse | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      txResult = await server.getTransaction(txHash);
      if (txResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) break;
    }

    if (txResult?.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return NextResponse.json({ hash: txHash, status: "SUCCESS" });
    }

    throw new Error(`Transaction failed: ${txResult?.status ?? "UNKNOWN"}`);
  } catch (error) {
    console.error("Error submitting Freighter transaction:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to submit transaction" },
      { status: 500 }
    );
  }
}

