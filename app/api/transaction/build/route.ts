import { NextRequest, NextResponse } from "next/server";
import {
  Contract,
  TransactionBuilder,
  Networks,
  Address,
  xdr,
  rpc,
  Keypair,
  Operation,
  hash,
} from "@stellar/stellar-sdk";
import { assembleTransaction } from "@stellar/stellar-sdk/rpc";
import { hashSorobanAuthPayload } from "@/lib/soroban-auth-payload";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  counterAddress: process.env.NEXT_PUBLIC_COUNTER_ADDRESS || "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U",
  bundlerSecret: process.env.BUNDLER_SECRET,
});

export async function POST(request: NextRequest) {
  const TESTNET_CONFIG = getConfig();

  if (!TESTNET_CONFIG.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const bundlerKeypair = Keypair.fromSecret(TESTNET_CONFIG.bundlerSecret);
    const server = new rpc.Server(TESTNET_CONFIG.rpcUrl);
    const { smartAccountAddress } = await request.json();

    if (!smartAccountAddress || typeof smartAccountAddress !== "string") {
      return NextResponse.json(
        { error: "Missing smartAccountAddress" },
        { status: 400 }
      );
    }

    // Build the transaction using bundler account as source (pays fees, signs envelope)
    const account = await server.getAccount(bundlerKeypair.publicKey());
    const contract = new Contract(TESTNET_CONFIG.counterAddress);

    const tx = new TransactionBuilder(account, {
      fee: "1000000",
      networkPassphrase: TESTNET_CONFIG.networkPassphrase,
    })
      .addOperation(
        contract.call("increment", new Address(smartAccountAddress).toScVal())
      )
      .setTimeout(300)
      .build();

    // Simulate to get auth payload
    const simResult = await server.simulateTransaction(tx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    if (!rpc.Api.isSimulationSuccess(simResult)) {
      throw new Error("Simulation did not succeed");
    }

    const authEntries = simResult.result?.auth;
    if (!authEntries || authEntries.length === 0) {
      throw new Error("No auth entries in simulation result");
    }

    // Get the auth entry - it may already be an XDR object or a base64 string
    const authEntry = typeof authEntries[0] === "string"
      ? xdr.SorobanAuthorizationEntry.fromXDR(authEntries[0], "base64")
      : authEntries[0] as xdr.SorobanAuthorizationEntry;
    const credentials = authEntry.credentials().address();

    // Set validity window - 60 ledgers (~5 minutes)
    const latestLedger = simResult.latestLedger;
    const validUntilLedger = latestLedger + 60;
    credentials.signatureExpirationLedger(validUntilLedger);

    // Merge simulation footprint into tx (required for valid Soroban auth context)
    const assembledBuilder = assembleTransaction(tx, simResult);
    assembledBuilder.clearOperations();
    const origOp = tx.operations[0] as Operation.InvokeHostFunction;
    assembledBuilder.addOperation(
      Operation.invokeHostFunction({
        source: origOp.source,
        func: origOp.func,
        auth: [authEntry],
      })
    );
    const assembledTx = assembledBuilder.build();

    // signaturePayload is the Soroban auth payload hash (32 bytes).
    const signaturePayload = hashSorobanAuthPayload(authEntry, TESTNET_CONFIG.networkPassphrase);
    // The current smart-account contract binds context_rule_ids into auth_digest
    // before calling the verifier, so external signers must sign authDigestHex.
    const ruleIdsXdr = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]).toXDR();
    const authDigest = hash(Buffer.concat([signaturePayload, Buffer.from(ruleIdsXdr)]));
    const authDigestHex = authDigest.toString("hex");

    // Handle transactionData - may be string, XDR object, or SorobanDataBuilder
    let transactionDataXdr: string | undefined;
    const txData = simResult.transactionData as unknown;

    if (typeof txData === "string") {
      transactionDataXdr = txData;
    } else if (txData && typeof (txData as { toXDR?: unknown }).toXDR === "function") {
      // Direct XDR object
      transactionDataXdr = (txData as { toXDR: (format: string) => string }).toXDR("base64");
    } else if (txData && typeof (txData as { build?: unknown }).build === "function") {
      // SorobanDataBuilder - need to call build() first
      const built = (txData as { build: () => { toXDR: (format: string) => string } }).build();
      transactionDataXdr = built.toXDR("base64");
    }

    return NextResponse.json({
      txXdr: assembledTx.toXDR(),
      authEntryXdr: authEntry.toXDR("base64"),
      simulationResultXdr: JSON.stringify({
        transactionData: transactionDataXdr,
        minResourceFee: simResult.minResourceFee,
        latestLedger: simResult.latestLedger,
      }),
      // Client signs: "Stellar Smart Account Auth:\n" + authDigestHex (lowercase hex)
      authDigestHex,
      // Raw Soroban auth payload hash, kept for diagnostics/debugging.
      signaturePayloadHex: signaturePayload.toString("hex"),
      validUntilLedger,
    });
  } catch (error) {
    console.error("Error building transaction:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build transaction" },
      { status: 500 }
    );
  }
}
