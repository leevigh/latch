import { NextRequest, NextResponse } from "next/server";
import {
  TransactionBuilder,
  Networks,
  Keypair,
  xdr,
  rpc,
  Transaction,
} from "@stellar/stellar-sdk";
import { contextRuleIdsForEntry } from "@/lib/soroban-auth-payload";
import { buildWebAuthnAuthPayload } from "@/lib/webauthn";
import {
  signBundlerDelegatedAuthEntry,
  isBundlerDelegatedCheckAuthEntry,
} from "@/lib/bundler-delegated-auth";
import {
  assembleSignedTxWithBundler,
  rebuildTxWithAuthEntries,
  submitWithBundler,
} from "@/lib/soroban-transaction-submit";

export const maxDuration = 60;
export const runtime = "nodejs";

/**
 * Submit a transaction with a WebAuthn-signed auth entry.
 *
 * Receives:
 *   txXdr           - base transaction XDR (unsigned envelope)
 *   authEntryXdr    - base64 smart-account auth entry with expiration set
 *   sigDataXdr      - hex: WebAuthnSigData XDR bytes from encodeWebAuthnSigData()
 *   keyDataHex      - hex: 65-byte pubkey || credentialId (the signer's key_data)
 *   contextRuleId   - u32: which context rule was used (default: 0)
 *   authEntriesXdr  - optional full auth entry list (passkey + bundler delegated G)
 *   smartAccountAuthEntryIndex - index of smart-account row in authEntriesXdr (default 0)
 *   delegatedGAuthEntrySynthesized - when true, sign bundler delegated entries server-side
 *
 * Flow:
 *   1. Rebuild auth entries with WebAuthn AuthPayload on smart-account row
 *   2. Sign any unsigned bundler delegated __check_auth entries with BUNDLER_SECRET
 *   3. Enforcing-mode simulate (validates signature on-chain)
 *   4. Assemble, fee-payer sign, submit
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
    const body = await request.json();
    const {
      txXdr,
      authEntryXdr,
      sigDataXdr,
      keyDataHex,
      contextRuleId,
      authEntriesXdr,
      smartAccountAuthEntryIndex: smartAccountIdxRaw,
      delegatedGAuthEntrySynthesized,
      submit,
    } = body;

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

    const smartAccountAuthEntryIndex =
      smartAccountIdxRaw !== undefined && smartAccountIdxRaw !== null
        ? Number(smartAccountIdxRaw)
        : 0;
    if (!Number.isInteger(smartAccountAuthEntryIndex) || smartAccountAuthEntryIndex < 0) {
      return NextResponse.json(
        { error: "smartAccountAuthEntryIndex must be a non-negative integer" },
        { status: 400 }
      );
    }

    const tx = TransactionBuilder.fromXDR(txXdr, config.networkPassphrase) as Transaction;

    const entries: xdr.SorobanAuthorizationEntry[] =
      Array.isArray(authEntriesXdr) && authEntriesXdr.length > 0
        ? authEntriesXdr.map((xdrB64: string) =>
            xdr.SorobanAuthorizationEntry.fromXDR(xdrB64, "base64")
          )
        : [xdr.SorobanAuthorizationEntry.fromXDR(authEntryXdr, "base64")];

    if (smartAccountAuthEntryIndex >= entries.length) {
      return NextResponse.json(
        { error: "smartAccountAuthEntryIndex is out of range for authEntriesXdr." },
        { status: 400 }
      );
    }

    const sigDataBytes = Buffer.from(sigDataXdr, "hex");
    const keyDataBytes = Buffer.from(keyDataHex, "hex");

    const smartAccountEntry = entries[smartAccountAuthEntryIndex];
    const contextRuleIds = contextRuleIdsForEntry(smartAccountEntry, ruleId);
    const authPayload = buildWebAuthnAuthPayload(
      config.webauthnVerifierAddress,
      keyDataBytes,
      sigDataBytes,
      contextRuleIds
    );
    smartAccountEntry.credentials().address().signature(authPayload);
    entries[smartAccountAuthEntryIndex] = smartAccountEntry;

    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);
    const bundlerPublicKey = bundlerKeypair.publicKey();

    const shouldSignBundler =
      delegatedGAuthEntrySynthesized === true ||
      entries.some((e) => isBundlerDelegatedCheckAuthEntry(e, bundlerPublicKey));

    if (shouldSignBundler) {
      for (let i = 0; i < entries.length; i++) {
        if (i === smartAccountAuthEntryIndex) continue;
        if (isBundlerDelegatedCheckAuthEntry(entries[i], bundlerPublicKey)) {
          entries[i] = signBundlerDelegatedAuthEntry(
            entries[i],
            bundlerKeypair,
            config.networkPassphrase
          );
        }
      }
    }

    let txWithAuth: Transaction;
    try {
      txWithAuth = rebuildTxWithAuthEntries(tx, config.networkPassphrase, entries);
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
      // submit === false: sign + assemble, return signed tx XDR for dApp RPC submit.
      if (submit === false) {
        const { signedTxXdr } = await assembleSignedTxWithBundler({
          server,
          networkPassphrase: config.networkPassphrase,
          bundlerSecret: config.bundlerSecret,
          txWithAuth,
        });
        return NextResponse.json({ signedTxXdr, submitted: false });
      }
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
