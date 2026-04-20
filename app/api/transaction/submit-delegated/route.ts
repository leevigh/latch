import { NextRequest, NextResponse } from "next/server";
import {
  TransactionBuilder,
  Networks,
  StrKey,
  xdr,
  rpc,
  Transaction,
  Operation,
  Keypair,
} from "@stellar/stellar-sdk";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

/**
 * Submits a delegated-signer transaction.
 * Expects:
 *   txXdr                  — assembled tx from build-delegated
 *   smartAccountAuthEntryXdr — base64 SorobanAuthorizationEntry with AuthPayload set
 *   gAddressEntryTemplateXdr — base64 SorobanAuthorizationEntry (unsigned G-address entry)
 *   signedAuthEntryBase64  — raw 64-byte Ed25519 signature from Freighter, base64-encoded
 *   signerAddress          — G-address that signed (from Freighter's signAuthEntry response)
 */
export async function POST(request: NextRequest) {
  const config = getConfig();
  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const server = new rpc.Server(config.rpcUrl);
    const { txXdr, smartAccountAuthEntryXdr, gAddressEntryTemplateXdr, signedAuthEntryBase64, signerAddress } = await request.json();

    if (!txXdr || !smartAccountAuthEntryXdr || !gAddressEntryTemplateXdr || !signedAuthEntryBase64 || !signerAddress) {
      return NextResponse.json(
        { error: "Missing required fields: txXdr, smartAccountAuthEntryXdr, gAddressEntryTemplateXdr, signedAuthEntryBase64, signerAddress" },
        { status: 400 }
      );
    }

    const tx = TransactionBuilder.fromXDR(txXdr, config.networkPassphrase) as Transaction;

    // Parse the smart account auth entry (already has AuthPayload set)
    const smartAccountEntry = xdr.SorobanAuthorizationEntry.fromXDR(smartAccountAuthEntryXdr, "base64");

    // Reconstruct the signed G-address entry.
    // Freighter returns the raw 64-byte Ed25519 signature as base64. We place it in the
    // standard Soroban account signature format: Vec([Map({ public_key, signature })]).
    const sigBytes = Buffer.from(signedAuthEntryBase64, "base64");
    if (sigBytes.length !== 64) {
      return NextResponse.json(
        { error: `Expected 64-byte signature from Freighter, got ${sigBytes.length} bytes` },
        { status: 400 }
      );
    }
    const pubkeyBytes = StrKey.decodeEd25519PublicKey(signerAddress);

    const accountSig = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("public_key"),
        val: xdr.ScVal.scvBytes(pubkeyBytes),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signature"),
        val: xdr.ScVal.scvBytes(sigBytes),
      }),
    ]);

    const gAddrEntry = xdr.SorobanAuthorizationEntry.fromXDR(gAddressEntryTemplateXdr, "base64");
    gAddrEntry.credentials().address().signature(xdr.ScVal.scvVec([accountSig]));

    const authEntries = [smartAccountEntry, gAddrEntry];

    // Rebuild operation with the signed auth entries
    const sorobanData = tx.toEnvelope().v1().tx().ext().value() as xdr.SorobanTransactionData;
    const origOp = tx.operations[0] as Operation.InvokeHostFunction;
    const tb = TransactionBuilder.cloneFrom(tx, {
      fee: tx.fee,
      sorobanData,
      networkPassphrase: config.networkPassphrase,
    });
    tb.clearOperations();
    tb.addOperation(
      Operation.invokeHostFunction({
        source: origOp.source,
        func: origOp.func,
        auth: authEntries,
      })
    );
    const txWithAuth = tb.build();

    // Enforcing simulation — validates all auth entries and gets final fees/footprint
    const enforcingSim = await server.simulateTransaction(txWithAuth);
    if (rpc.Api.isSimulationError(enforcingSim)) {
      return NextResponse.json(
        { error: `Auth validation failed: ${enforcingSim.error}` },
        { status: 400 }
      );
    }

    const assembledTx = rpc.assembleTransaction(txWithAuth, enforcingSim).build();
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);
    assembledTx.sign(bundlerKeypair);

    const sendResult = await server.sendTransaction(assembledTx);
    if (sendResult.status === "ERROR") {
      throw new Error(`Submission failed: ${sendResult.errorResult?.toXDR("base64")}`);
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
    console.error("Error submitting delegated transaction:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to submit transaction" },
      { status: 500 }
    );
  }
}
