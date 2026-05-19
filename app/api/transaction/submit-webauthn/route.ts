import { NextRequest, NextResponse } from "next/server";
import {
  TransactionBuilder,
  Networks,
  Address,
  xdr,
  rpc,
  Transaction,
} from "@stellar/stellar-sdk";
import {
  rebuildTxWithAuthEntries,
  submitWithBundler,
} from "@/lib/soroban-transaction-submit";

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
      contextRuleId,
    } = await request.json();

    if (
      !txXdr ||
      !authEntryXdr ||
      !sigDataXdr ||
      !keyDataHex ||
      contextRuleId === undefined ||
      contextRuleId === null
    ) {
      return NextResponse.json(
        { error: "Missing required parameters (including contextRuleId)." },
        { status: 400 }
      );
    }

    const ruleId = Number(contextRuleId);
    if (!Number.isInteger(ruleId) || ruleId < 0) {
      return NextResponse.json(
        { error: "contextRuleId must be a non-negative integer" },
        { status: 400 }
      );
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
        val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(ruleId)]),
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

    let txWithAuth: Transaction;
    try {
      txWithAuth = rebuildTxWithAuthEntries(tx, config.networkPassphrase, [authEntry]);
    } catch (e) {
      return NextResponse.json(
        {
          error:
            e instanceof Error
              ? e.message
              : "Transaction missing Soroban data. Rebuild and submit again.",
        },
        { status: 400 }
      );
    }

    try {
      const { hash: txHash, status } = await submitWithBundler({
        server,
        networkPassphrase: config.networkPassphrase,
        bundlerSecret: config.bundlerSecret,
        txWithAuth,
      });
      return NextResponse.json({ hash: txHash, status });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("Auth validation failed")) {
        return NextResponse.json(
          { error: `WebAuthn signature validation failed: ${msg}` },
          { status: 400 }
        );
      }
      throw e;
    }
  } catch (error) {
    console.error("WebAuthn submit error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to submit transaction" },
      { status: 500 }
    );
  }
}
