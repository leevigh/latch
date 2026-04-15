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
} from "@stellar/stellar-sdk";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

async function fundAccountIfNeeded(gAddress: string): Promise<void> {
  try {
    const horizonResponse = await fetch(`https://horizon-testnet.stellar.org/accounts/${gAddress}`);
    if (horizonResponse.ok) return;
  } catch {
    // ignore
  }
  const response = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(gAddress)}`);
  if (!response.ok) {
    throw new Error(`Failed to fund account: ${response.statusText}`);
  }
}

/**
 * Submits a tx with Soroban auth entries already signed client-side (delegated/native scheme).
 * Server acts as fee-payer: Enforcing-mode simulate, assemble, sign envelope, submit.
 */
export async function POST(request: NextRequest) {
  const config = getConfig();
  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set in environment variables." }, { status: 500 });
  }

  try {
    const server = new rpc.Server(config.rpcUrl);
    const { txXdr, authEntriesXdr } = await request.json();

    if (!txXdr || !Array.isArray(authEntriesXdr) || authEntriesXdr.length < 1) {
      return NextResponse.json({ error: "Missing required parameters (txXdr, authEntriesXdr[])" }, { status: 400 });
    }

    const tx = TransactionBuilder.fromXDR(txXdr, config.networkPassphrase) as Transaction;

    const authEntries = authEntriesXdr.map((b64: string) =>
      xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64")
    );

    // Basic sanity checks: if a delegated signer auth entry is included, it must contain non-empty signature bytes.
    // This helps catch "signed auth entry was never produced" errors early.
    const getSignatureLen = (entry: xdr.SorobanAuthorizationEntry): number => {
      try {
        const creds = entry.credentials();
        if (creds.switch().name !== "sorobanCredentialsAddress") return 0;
        const sig = creds.address().signature();
        if (sig.switch().name !== "scvVec") return 0;
        const vec = sig.vec();
        if (!vec || vec.length === 0) return 0;
        const first = vec[0];
        if (first.switch().name !== "scvMap") return 0;
        const map = first.map();
        if (!map) return 0;
        for (const ent of map) {
          const k = ent.key();
          const v = ent.val();
          if (k.switch().name === "scvSymbol" && k.sym().toString() === "signature") {
            if (v.switch().name === "scvBytes") return v.bytes().length;
          }
        }
      } catch {
        // ignore
      }
      return 0;
    };

    // Any auth entry whose address is a G... (delegated signer) should have a non-empty signature.
    for (const entry of authEntries) {
      try {
        const creds = entry.credentials();
        if (creds.switch().name !== "sorobanCredentialsAddress") continue;
        const addrStr = Address.fromScAddress(creds.address().address()).toString();
        if (addrStr.startsWith("G")) {
          const len = getSignatureLen(entry);
          if (len <= 0) {
            return NextResponse.json(
              { error: "Delegated signer auth entry has empty signature bytes. Wallet did not sign auth entry." },
              { status: 400 }
            );
          }
        }
      } catch {
        // ignore
      }
    }

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

    const enforcingSim = await server.simulateTransaction(txWithAuth);
    if (rpc.Api.isSimulationError(enforcingSim)) {
      return NextResponse.json({ error: `Auth validation failed: ${enforcingSim.error}` }, { status: 400 });
    }

    const assembledTx = rpc.assembleTransaction(txWithAuth, enforcingSim).build();
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);

    // Ensure fee-payer exists on testnet (fresh envs commonly need friendbot).
    try {
      await server.getAccount(bundlerKeypair.publicKey());
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Account not found")) {
        await fundAccountIfNeeded(bundlerKeypair.publicKey());
      } else {
        throw e;
      }
    }

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
    console.error("Error submitting delegated transaction:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to submit transaction" },
      { status: 500 }
    );
  }
}

