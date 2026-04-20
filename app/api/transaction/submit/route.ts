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
  scValToNative,
  hash,
} from "@stellar/stellar-sdk";
import { hashSorobanAuthPayload } from "@/lib/soroban-auth-payload";
import nacl from "tweetnacl";

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

    const EXPECTED_PREFIX = "Stellar Smart Account Auth:\n";
    const EXPECTED_MSG_LEN = EXPECTED_PREFIX.length + 64; // prefix + lowercase hex of 32-byte hash
    if (prefixedMessage.length !== EXPECTED_MSG_LEN || !prefixedMessage.startsWith(EXPECTED_PREFIX)) {
      return NextResponse.json(
        { error: `prefixedMessage must be ${EXPECTED_MSG_LEN} chars (${EXPECTED_PREFIX.slice(0, 20)}…+64 hex)` },
        { status: 400 }
      );
    }
    if (!/^[0-9a-f]{64}$/.test(prefixedMessage.slice(EXPECTED_PREFIX.length))) {
      return NextResponse.json(
        { error: "Auth hash in prefixedMessage must be 64 lowercase hex chars" },
        { status: 400 }
      );
    }
    if (!/^[0-9a-f]{128}$/.test(authSignatureHex)) {
      return NextResponse.json(
        { error: "authSignatureHex must be 128 hex chars (64-byte Ed25519 signature)" },
        { status: 400 }
      );
    }
    if (!/^[0-9a-f]{64}$/.test(publicKeyHex)) {
      return NextResponse.json(
        { error: "publicKeyHex must be 64 hex chars (32-byte Ed25519 public key)" },
        { status: 400 }
      );
    }

    // Reconstruct objects from XDR
    const tx = TransactionBuilder.fromXDR(
      txXdr,
      TESTNET_CONFIG.networkPassphrase
    ) as Transaction;

    const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");

    const signaturePayload = hashSorobanAuthPayload(authEntry, TESTNET_CONFIG.networkPassphrase);
    const signaturePayloadHex = signaturePayload.toString("hex");
    const contextRuleIds = [0];
    const ruleIdsXdr = xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))).toXDR();
    const authDigest = hash(Buffer.concat([signaturePayload, Buffer.from(ruleIdsXdr)]));
    const authDigestHex = authDigest.toString("hex");
    const signedPayloadHex = prefixedMessage.slice(EXPECTED_PREFIX.length);
    if (signedPayloadHex !== authDigestHex) {
      return NextResponse.json(
        {
          error: `Signed auth hash does not match authDigest. signed=${signedPayloadHex} expected=${authDigestHex}. If this page was already open, hard refresh and try again.`,
        },
        { status: 400 }
      );
    }

    const authSignatureBytes = Buffer.from(authSignatureHex, "hex");
    if (authSignatureBytes.length !== 64) {
      return NextResponse.json(
        { error: `authSignatureHex must decode to exactly 64 bytes (got ${authSignatureBytes.length})` },
        { status: 400 }
      );
    }

    // Build the OZ AuthPayload:
    //   { context_rule_ids: [0], signers: { External(verifier, pubkey) => sig_data } }
    // The signers map value is passed verbatim as the Bytes argument to verifier.verify().
    // The Ed25519 phantom verifier sig_data type is BytesN<64> — raw 64-byte signature.
    // Do NOT XDR-wrap it: OZ stores it as raw Bytes and the host wraps in scvBytes when calling.
    const phantomPubkeyBytes = Buffer.from(publicKeyHex, "hex");
    if (phantomPubkeyBytes.length !== 32) {
      return NextResponse.json(
        { error: `publicKeyHex must decode to exactly 32 bytes (got ${phantomPubkeyBytes.length})` },
        { status: 400 }
      );
    }

    const signerKey = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("External"),
      Address.fromString(TESTNET_CONFIG.verifierAddress).toScVal(),
      xdr.ScVal.scvBytes(phantomPubkeyBytes),
    ]);

    const signaturesScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("context_rule_ids"),
        val: xdr.ScVal.scvVec(contextRuleIds.map((id) => xdr.ScVal.scvU32(id))),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signers"),
        val: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: signerKey,
            // Raw 64-byte signature — the verifier's SigData type is BytesN<64>.
            val: xdr.ScVal.scvBytes(authSignatureBytes),
          }),
        ]),
      }),
    ]);

    // Set the signature on the auth entry
    const credentials = authEntry.credentials().address();
    credentials.signature(signaturesScVal);

    const env = tx.toEnvelope();
    if (env.switch().name !== "envelopeTypeTx") {
      return NextResponse.json({ error: "Expected a v1 transaction envelope" }, { status: 400 });
    }
    const txExt = env.v1().tx().ext();
    if (txExt.switch() === 0) {
      return NextResponse.json(
        {
          error:
            "Transaction is missing Soroban resource data. Call /api/transaction/build again and submit the new txXdr.",
        },
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

    const extractVerifierHashHexFromDiagnostics = (diagnosticEventsXdr: unknown): string | undefined => {
      const events = Array.isArray(diagnosticEventsXdr) ? diagnosticEventsXdr : [];

      const toNative = (scv: xdr.ScVal): unknown => {
        try {
          return scValToNative(scv);
        } catch {
          // ignore
        }
        return undefined;
      };

      const bytes32HexFromNative = (native: unknown): string | undefined => {
        if (native instanceof Uint8Array && native.length === 32) {
          return Buffer.from(native).toString("hex");
        }
        if (Array.isArray(native)) {
          // For a verifier call, data is usually [hash, key_data, sig_data]
          for (const v of native) {
            const h = bytes32HexFromNative(v);
            if (h) return h;
          }
        }
        if (native && typeof native === "object") {
          // Maps/objects can contain nested arrays/bytes
          for (const v of Object.values(native as Record<string, unknown>)) {
            const h = bytes32HexFromNative(v);
            if (h) return h;
          }
        }
        return undefined;
      };

      for (const ev of events) {
        try {
          const parsed =
            typeof ev === "string"
              ? xdr.DiagnosticEvent.fromXDR(ev, "base64")
              : (ev as xdr.DiagnosticEvent);
          const contractEvent = parsed.event();
          const body = contractEvent.body()?.v0?.();
          if (!body) continue;

          // Prefer the explicit fn_call event for the verifier's verify().
          const topics = body.topics() ?? [];
          const nativeTopics = topics.map((t) => toNative(t));
          const sawFnCall = nativeTopics.includes("fn_call");
          const sawVerify = nativeTopics.includes("verify");
          const sawVerifierAddr = nativeTopics.includes(TESTNET_CONFIG.verifierAddress);

          if (!(sawFnCall && sawVerify && sawVerifierAddr)) continue;

          const dataNative = body.data() ? toNative(body.data()) : undefined;
          const hashHex = bytes32HexFromNative(dataNative);
          if (hashHex) return hashHex;
        } catch {
          // ignore parsing errors
        }
      }
      return undefined;
    };

    // Enforcing Mode simulation: validates the signature and gets accurate
    // footprint + resource fees. This replaces all manual footprint patching,
    // instruction padding, and fee calculation.
    const enforcingSim = await server.simulateTransaction(txWithAuth);

    if (rpc.Api.isSimulationError(enforcingSim)) {
      const verifierHashHex = extractVerifierHashHexFromDiagnostics((enforcingSim as any).diagnosticEventsXdr);
      let localVerifyPrefixPlusHexUtf8: boolean | undefined;
      let localVerifyPrefixPlusRawHash: boolean | undefined;
      if (verifierHashHex) {
        try {
          const prefix = Buffer.from(EXPECTED_PREFIX, "utf-8");
          const hashBytes = Buffer.from(verifierHashHex, "hex");
          const sigBytes = authSignatureBytes;
          const pkBytes = phantomPubkeyBytes;

          const msgHexUtf8 = Buffer.from(EXPECTED_PREFIX + verifierHashHex, "utf-8");
          const msgPrefixPlusRawHash = Buffer.concat([prefix, hashBytes]);

          localVerifyPrefixPlusHexUtf8 = nacl.sign.detached.verify(msgHexUtf8, sigBytes, pkBytes);
          localVerifyPrefixPlusRawHash = nacl.sign.detached.verify(msgPrefixPlusRawHash, sigBytes, pkBytes);
        } catch {
          // ignore
        }
      }
      return NextResponse.json(
        {
          error: `Auth validation failed: ${enforcingSim.error}`,
          verifierHashHex,
          signaturePayloadHex,
          localVerifyPrefixPlusHexUtf8,
          localVerifyPrefixPlusRawHash,
        },
        { status: 400 }
      );
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
