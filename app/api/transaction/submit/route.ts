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
  Account,
} from "@stellar/stellar-sdk";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  verifierAddress: process.env.NEXT_PUBLIC_VERIFIER_ADDRESS,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

export async function POST(request: NextRequest) {
  const TESTNET_CONFIG = getConfig();

  if (!TESTNET_CONFIG.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set in environment variables." }, { status: 500 });
  }
  if (!TESTNET_CONFIG.verifierAddress) {
    return NextResponse.json({ error: "NEXT_PUBLIC_VERIFIER_ADDRESS is not set in environment variables." }, { status: 500 });
  }

  try {
    const server = new rpc.Server(TESTNET_CONFIG.rpcUrl);
    const {
      txXdr,
      authEntryXdr,
      authSignatureHex,  // Phantom signature for smart account authorization
      prefixedMessage,    // The full message that was signed (PREFIX + hex(payload))
      publicKeyHex,
    } = await request.json();

    if (!txXdr || !authEntryXdr || !authSignatureHex || !prefixedMessage || !publicKeyHex) {
      return NextResponse.json(
        { error: "Missing required parameters" },
        { status: 400 }
      );
    }

    // Reconstruct objects from XDR
    const tx = TransactionBuilder.fromXDR(
      txXdr,
      TESTNET_CONFIG.networkPassphrase
    ) as Transaction;

    const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");

    // Build Ed25519SigData struct (prefixed_message + signature) and encode to XDR
    // This is what the verifier expects as sig_data
    const prefixedMessageBytes = Buffer.from(prefixedMessage, "utf-8");
    const authSignatureBytes = Buffer.from(authSignatureHex, "hex");

    // Create Ed25519SigData ScMap: { prefixed_message: Bytes, signature: BytesN<64> }
    // Note: Map keys must be sorted lexicographically
    const sigDataMap = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("prefixed_message"),
        val: xdr.ScVal.scvBytes(prefixedMessageBytes),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signature"),
        val: xdr.ScVal.scvBytes(authSignatureBytes),
      }),
    ]);

    // Encode the ScMap to XDR bytes (like Rust's to_xdr() does)
    const sigDataXdr = sigDataMap.toXDR();

    // Wrap the XDR bytes in ScBytes (this is what the verifier receives as sig_data)
    const sigDataBytes = xdr.ScVal.scvBytes(sigDataXdr);

    // Build the AuthPayload named struct for the smart account auth.
    // The stellar_accounts crate defines:
    // pub struct AuthPayload {
    //     pub context_rule_ids: Vec<u32>,
    //     pub signers: Map<Signer, Bytes>,
    // }
    // As a named struct, it serializes to XDR as a Map with Symbol keys sorted alphabetically.
    const phantomPubkeyBytes = Buffer.from(publicKeyHex, "hex");

    const signerKey = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("External"),
      Address.fromString(TESTNET_CONFIG.verifierAddress).toScVal(),
      xdr.ScVal.scvBytes(phantomPubkeyBytes),
    ]);

    const authPayloadMap = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("context_rule_ids"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]), // Maps auth_contexts[0] to rule ID 0 (the default rule created in constructor)
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signers"),
        val: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: signerKey,
            val: sigDataBytes,  // XDR-encoded Ed25519SigData struct
          }),
        ]),
      }),
    ]);

    // Set the signature on the auth entry
    const credentials = authEntry.credentials().address();
    credentials.signature(authPayloadMap);

    // Build new transaction with signed auth entry
    const origOp = tx.operations[0] as Operation.InvokeHostFunction;
    const sourceAccount = new Account(tx.source, (BigInt(tx.sequence) - BigInt(1)).toString());

    const txWithAuth = new TransactionBuilder(sourceAccount, {
      fee: "100000",
      networkPassphrase: TESTNET_CONFIG.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: origOp.func,
          auth: [authEntry],
        })
      )
      .setTimeout(300)
      .build();

    // Enforcing Mode simulation: validates the signature and gets accurate
    // footprint + resource fees. This replaces all manual footprint patching,
    // instruction padding, and fee calculation.
    const enforcingSim = await server.simulateTransaction(txWithAuth);

    if (rpc.Api.isSimulationError(enforcingSim)) {
      throw new Error(`Auth validation failed: ${enforcingSim.error}`);
    }

    // assembleTransaction applies correct footprint + resource fees automatically
    const assembledTx = rpc.assembleTransaction(txWithAuth, enforcingSim).build();

    console.log(`Enforcing Mode: fee=${assembledTx.fee}, minResourceFee=${enforcingSim.minResourceFee}`);

    // Sign the envelope with bundler keypair (server-side)
    const bundlerKeypair = Keypair.fromSecret(TESTNET_CONFIG.bundlerSecret);
    assembledTx.sign(bundlerKeypair);

    // Submit
    const sendResult = await server.sendTransaction(assembledTx);

    if (sendResult.status === "ERROR") {
      throw new Error(
        `Transaction submission failed: ${sendResult.errorResult?.toXDR("base64")}`
      );
    }

    // Poll for result
    const txHash = sendResult.hash;
    console.log(`\n✅ Transaction submitted: ${txHash}`);
    console.log(`   View on explorer: https://stellar.expert/explorer/testnet/tx/${txHash}`);

    let txResult: rpc.Api.GetTransactionResponse | undefined;

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      txResult = await server.getTransaction(txHash);

      if (txResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        break;
      }
    }

    if (txResult!.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      return NextResponse.json({
        hash: txHash,
        status: "SUCCESS",
      });
    }

    // Get detailed error information
    let errorDetail: string = txResult!.status;
    if (txResult!.status === rpc.Api.GetTransactionStatus.FAILED) {
      const result = txResult as rpc.Api.GetFailedTransactionResponse;

      // Log diagnostic events to understand what failed
      if ('diagnosticEventsXdr' in result && Array.isArray((result as any).diagnosticEventsXdr)) {
        console.error("\n=== Diagnostic Events ===");
        (result as any).diagnosticEventsXdr.forEach((diagnosticEvent: any, i: number) => {
          try {
            // diagnosticEvent is already a parsed XDR object
            const event = diagnosticEvent._attributes.event;
            const eventType = event._attributes.type?._switch?.name || 'unknown';
            console.error(`\nEvent ${i} (${eventType}):`);

            if (eventType === 'contract') {
              const body = event._attributes.body?._value;
              if (body) {
                const topics = body._attributes?.topics?._value || [];
                const data = body._attributes?.data;
                console.error(`  Topics:`, topics.map((t: any) => {
                  try {
                    const val = t._switch?.name || JSON.stringify(t);
                    return val;
                  } catch {
                    return '[complex]';
                  }
                }));
                console.error(`  Data:`, data);
              }
            }
          } catch (e) {
            console.error(`Event ${i}: Error extracting -`, e);
          }
        });
      }

      // resultXdr is already an XDR object, not a string
      const parsedResult = result.resultXdr as xdr.TransactionResult;
      const resultCode = parsedResult.result().switch().name;
      const opResults = parsedResult.result().results();

      console.error("Transaction result code:", resultCode);

      if (opResults && opResults.length > 0) {
        const opResult = opResults[0];
        const opResultCode = opResult.switch().name;
        console.error("Operation result code:", opResultCode);

        if (opResultCode === "opInner") {
          const innerResult = opResult.value();
          const invokeResult = (innerResult as any).switch().name;
          console.error("Invoke result:", invokeResult);

          // If it's invokeHostFunctionTrapped, get the diagnostic events
          if (invokeResult === "invokeHostFunctionTrapped") {
            errorDetail = `${result.status} - Contract execution failed (trapped)`;
          } else {
            errorDetail = `${result.status} - ${resultCode} - ${opResultCode} - ${invokeResult}`;
          }
        } else {
          errorDetail = `${result.status} - ${resultCode} - ${opResultCode}`;
        }
      } else {
        errorDetail = `${result.status} - ${resultCode}`;
      }
    }

    throw new Error(`Transaction failed: ${errorDetail}`);
  } catch (error) {
    console.error("Error submitting transaction:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to submit transaction" },
      { status: 500 }
    );
  }
}
