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
import { hashSorobanAuthPayload } from "@/lib/soroban-auth-payload";
import { hash } from "@stellar/stellar-sdk";

/**
 * Submit a transaction with a WebAuthn-signed auth entry.
 *
 * Receives:
 *   txXdr           - base transaction XDR (unsigned envelope)
 *   authEntryXdr    - base64 auth entry with expiration set
 *   sigDataXdr      - hex: WebAuthnSigData XDR bytes from encodeWebAuthnSigData()
 *   keyDataHex      - hex: 65-byte pubkey || credentialId (the signer's key_data)
 *   contextRuleId   - u32: which context rule was used (default: 0)
 *   verifierAddress - the deployed WebAuthn verifier contract address
 *
 * Flow:
 *   1. Rebuild auth entry with WebAuthn AuthPayload
 *   2. Enforcing-mode simulate (validates signature on-chain)
 *   3. Assemble, fee-payer sign, submit
 */

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  webauthnVerifierAddress:
    process.env.NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

export async function POST(request: NextRequest) {
  const config = getConfig();

  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }
  if (!config.webauthnVerifierAddress) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS is not set." },
      { status: 500 }
    );
  }

  try {
    const server = new rpc.Server(config.rpcUrl);
    const {
      txXdr,
      authEntryXdr,
      sigDataXdr,    // hex string: WebAuthnSigData XDR bytes
      keyDataHex,    // hex string: 65-byte pubkey || credentialId
      contextRuleId = 0,
    } = await request.json();

    if (!txXdr || !authEntryXdr || !sigDataXdr || !keyDataHex) {
      return NextResponse.json({ error: "Missing required parameters." }, { status: 400 });
    }

    const tx = TransactionBuilder.fromXDR(txXdr, config.networkPassphrase) as Transaction;
    const authEntry = xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64");

    const sigDataBytes = Buffer.from(sigDataXdr, "hex");
    const keyDataBytes = Buffer.from(keyDataHex, "hex");

    // Build the AuthPayload ScVal:
    //   AuthPayload {
    //     context_rule_ids: [contextRuleId],
    //     signers: { External(verifier, keyData) => sigDataXdr }
    //   }
    const signerKey = xdr.ScVal.scvVec([
      xdr.ScVal.scvSymbol("External"),
      xdr.ScVal.scvAddress(
        Address.fromString(config.webauthnVerifierAddress).toScAddress()
      ),
      xdr.ScVal.scvBytes(keyDataBytes),
    ]);

    const authPayload = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("context_rule_ids"),
        val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(contextRuleId)]),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("signers"),
        val: xdr.ScVal.scvMap([
          new xdr.ScMapEntry({
            key: signerKey,
            val: xdr.ScVal.scvBytes(sigDataBytes),
          }),
        ]),
      }),
    ]);

    const credentials = authEntry.credentials().address();
    credentials.signature(authPayload);

    // Rebuild tx with signed auth entry
    const origOp = tx.operations[0] as Operation.InvokeHostFunction;
    const sourceAccount = new Account(
      tx.source,
      (BigInt(tx.sequence) - BigInt(1)).toString()
    );

    const txWithAuth = new TransactionBuilder(sourceAccount, {
      fee: "100000",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        Operation.invokeHostFunction({
          func: origOp.func,
          auth: [authEntry],
        })
      )
      .setTimeout(300)
      .build();

    // Enforcing-mode simulation: validates signature on-chain before submission
    const enforcingSim = await server.simulateTransaction(txWithAuth);
    if (rpc.Api.isSimulationError(enforcingSim)) {
      return NextResponse.json(
        { error: `WebAuthn signature validation failed: ${enforcingSim.error}` },
        { status: 400 }
      );
    }

    const assembled = rpc.assembleTransaction(txWithAuth, enforcingSim).build();
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);
    assembled.sign(bundlerKeypair);

    const sendResult = await server.sendTransaction(assembled);
    if (sendResult.status === "ERROR") {
      throw new Error(
        `Transaction submission failed: ${sendResult.errorResult?.toXDR("base64")}`
      );
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

    throw new Error(`Transaction failed: ${txResult?.status ?? "TIMEOUT"}`);
  } catch (error) {
    console.error("WebAuthn submit error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to submit transaction" },
      { status: 500 }
    );
  }
}
