import { NextRequest, NextResponse } from "next/server";
import {
  TransactionBuilder,
  Networks,
  Keypair,
  xdr,
  rpc,
  Transaction,
} from "@stellar/stellar-sdk";
import { ApiRequestError } from "@/lib/api-errors";
import { applyDelegatedFreighterSignature } from "@/lib/delegated-check-auth-entry";
import { buildUnsignedDelegatedGCheckAuthEntry } from "@/lib/delegated-native-auth-entry";
import { computeAuthDigest, contextRuleIdsForEntry } from "@/lib/soroban-auth-payload";
import {
  signBundlerDelegatedAuthEntry,
  isBundlerDelegatedCheckAuthEntry,
} from "@/lib/bundler-delegated-auth";
import { contextRuleIdsFromSmartAccountAuthEntry, delegatedGFromSmartAccountAuthEntry, hasExternalAuthPayload } from "@/lib/soroban-auth-payload-parse";
import { addressStringFromCredentials, isUnsignedAddressAuthEntry } from "@/lib/soroban-auth-entries";
import { delegatedCheckAuthArgHex } from "@/lib/delegated-check-auth-entry";
import { getBundlerKeypair, resolveSignerKeypairForG } from "@/lib/bundler-config";
import {
  assembleSignedTxWithBundler,
  rebuildTxWithAuthEntries,
  submitWithBundler,
} from "@/lib/soroban-transaction-submit";

export const maxDuration = 60;
export const runtime = "nodejs";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

function resolveContextRuleIds(
  smartAccountEntry: xdr.SorobanAuthorizationEntry,
  contextRuleIdFromBody: unknown
): number[] {
  const fromPayload = contextRuleIdsFromSmartAccountAuthEntry(smartAccountEntry);
  if (fromPayload.length > 0) return fromPayload;

  if (contextRuleIdFromBody !== undefined && contextRuleIdFromBody !== null) {
    const id = Number(contextRuleIdFromBody);
    if (Number.isInteger(id) && id >= 0) {
      return contextRuleIdsForEntry(smartAccountEntry, id);
    }
  }

  throw new Error(
    "Could not determine contextRuleId. Pass contextRuleId from prepare-sign or ensure smartAccountAuthEntryXdr includes context_rule_ids in its AuthPayload."
  );
}

/** Replace any bundler G row with a fresh unsigned __check_auth entry for the correct auth_digest. */
function upsertBundlerDelegatedEntry(
  entries: xdr.SorobanAuthorizationEntry[],
  smartAccountAuthEntryIndex: number,
  bundlerPublicKey: string,
  smartAccountAddress: string,
  networkPassphrase: string,
  contextRuleIds: number[]
): void {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (i === smartAccountAuthEntryIndex) continue;
    if (addressStringFromCredentials(entries[i]) === bundlerPublicKey) {
      entries.splice(i, 1);
    }
  }

  const smartAccountEntry = entries[smartAccountAuthEntryIndex];
  const validUntil = smartAccountEntry.credentials().address().signatureExpirationLedger();
  const expectedDigestHex = computeAuthDigest(
    smartAccountEntry,
    networkPassphrase,
    contextRuleIds
  ).toString("hex");

  entries.push(
    buildUnsignedDelegatedGCheckAuthEntry({
      smartAccountAddress,
      signerG: bundlerPublicKey,
      authDigestHash: Buffer.from(expectedDigestHex, "hex"),
      signatureExpirationLedger: validUntil,
    })
  );
}

function bundlerEntryDigestMatches(
  entry: xdr.SorobanAuthorizationEntry,
  expectedDigestHex: string
): boolean {
  const argHex = delegatedCheckAuthArgHex(entry);
  return argHex !== null && argHex === expectedDigestHex;
}

function signDelegatedEntriesInPlace(
  entries: xdr.SorobanAuthorizationEntry[],
  smartAccountAuthEntryIndex: number,
  networkPassphrase: string
): void {
  for (let i = 0; i < entries.length; i++) {
    if (i === smartAccountAuthEntryIndex) continue;
    const addr = addressStringFromCredentials(entries[i]);
    if (!addr) continue;
    const keypair = resolveSignerKeypairForG(addr);
    if (!keypair) continue;
    if (!isUnsignedAddressAuthEntry(entries[i])) continue;
    if (!delegatedCheckAuthArgHex(entries[i])) continue;
    entries[i] = signBundlerDelegatedAuthEntry(
      entries[i],
      keypair,
      networkPassphrase
    );
  }
}

/**
 * Submits a transaction signed by a delegated G-address (Freighter / on-chain Delegated signer).
 * Used for token sends, swap setup, and swaps that authorize via Delegated(G).
 */
export async function POST(request: NextRequest) {
  const config = getConfig();
  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const server = new rpc.Server(config.rpcUrl);
    const bundlerKeypair = getBundlerKeypair();
    const bundlerPublicKey = bundlerKeypair.publicKey();

    const body = await request.json();
    const {
      txXdr,
      smartAccountAuthEntryXdr,
      gAddressEntryTemplateXdr,
      signedAuthEntryBase64,
      signerAddress,
      authEntriesXdr,
      smartAccountAuthEntryIndex: smartAccountIdxRaw,
      delegatedGAuthEntrySynthesized,
      contextRuleId,
      submit,
    } = body;

    if (!txXdr || !smartAccountAuthEntryXdr) {
      return NextResponse.json(
        { error: "Missing required fields: txXdr, smartAccountAuthEntryXdr" },
        { status: 400 }
      );
    }

    // When submit === false, sign + assemble but return the signed tx XDR
    // instead of broadcasting, so the dApp can submit via RPC itself.
    const finalize = async (txWithAuth: Transaction) => {
      if (submit === false) {
        const { signedTxXdr } = await assembleSignedTxWithBundler({
          server,
          networkPassphrase: config.networkPassphrase,
          bundlerSecret: config.bundlerSecret!,
          txWithAuth,
        });
        return NextResponse.json({ signedTxXdr, submitted: false });
      }
      const { hash, status } = await submitWithBundler({
        server,
        networkPassphrase: config.networkPassphrase,
        bundlerSecret: config.bundlerSecret!,
        txWithAuth,
      });
      return NextResponse.json({ hash, status });
    };

    const smartAccountAuthEntryIndex =
      smartAccountIdxRaw !== undefined && smartAccountIdxRaw !== null
        ? Number(smartAccountIdxRaw)
        : 0;

    const tx = TransactionBuilder.fromXDR(txXdr, config.networkPassphrase) as Transaction;
    const smartAccountEntry = xdr.SorobanAuthorizationEntry.fromXDR(
      smartAccountAuthEntryXdr,
      "base64"
    );

    const delegatedG = delegatedGFromSmartAccountAuthEntry(smartAccountEntry);
    const bundlerDelegatedPath =
      delegatedG !== null && !hasExternalAuthPayload(smartAccountEntry);

    let entries: xdr.SorobanAuthorizationEntry[];

    if (Array.isArray(authEntriesXdr) && authEntriesXdr.length > 0) {
      entries = authEntriesXdr.map((xdrB64: string) =>
        xdr.SorobanAuthorizationEntry.fromXDR(xdrB64, "base64")
      );
      if (smartAccountAuthEntryIndex < entries.length) {
        entries[smartAccountAuthEntryIndex] = smartAccountEntry;
      } else {
        entries.push(smartAccountEntry);
      }
    } else {
      entries = [smartAccountEntry];
    }

    // Drop unsigned address-credential stubs (e.g. SAC placeholders); keep signed rows.
    entries = entries.filter((entry, i) => {
      if (i === smartAccountAuthEntryIndex) return true;
      const addr = addressStringFromCredentials(entry);
      if (addr && isUnsignedAddressAuthEntry(entry)) return false;
      return true;
    });
    const smartIdx = entries.findIndex(
      (_, i) =>
        addressStringFromCredentials(entries[i]) ===
        addressStringFromCredentials(smartAccountEntry)
    );
    const resolvedSmartAccountIndex = smartIdx >= 0 ? smartIdx : smartAccountAuthEntryIndex;

    // On-chain rule uses Delegated G: sign server-side when configured, else client Freighter path.
    if (bundlerDelegatedPath) {
      const smartAccountAddr = addressStringFromCredentials(smartAccountEntry);
      if (!smartAccountAddr) {
        return NextResponse.json(
          { error: "Could not read smart account address from auth entry." },
          { status: 400 }
        );
      }

      const contextRuleIds = resolveContextRuleIds(smartAccountEntry, contextRuleId);
      const delegatedSignerKeypair = resolveSignerKeypairForG(delegatedG!);

      if (delegatedSignerKeypair) {
        upsertBundlerDelegatedEntry(
          entries,
          resolvedSmartAccountIndex,
          delegatedG!,
          smartAccountAddr,
          config.networkPassphrase,
          contextRuleIds
        );

        signDelegatedEntriesInPlace(
          entries,
          resolvedSmartAccountIndex,
          config.networkPassphrase
        );

        const txWithAuth = rebuildTxWithAuthEntries(tx, config.networkPassphrase, entries);
        return finalize(txWithAuth);
      }

      if (!gAddressEntryTemplateXdr || !signedAuthEntryBase64 || !signerAddress) {
        return NextResponse.json(
          {
            error:
              `Missing delegated signer fields for ${delegatedG}: gAddressEntryTemplateXdr, signedAuthEntryBase64, signerAddress`,
            code: "SIGNER_MISMATCH",
            delegatedAuthG: delegatedG,
          },
          { status: 400 }
        );
      }

      if (signerAddress !== delegatedG) {
        return NextResponse.json(
          {
            error: `signerAddress must be ${delegatedG} (on-chain delegated signer for this setup transaction).`,
            code: "validation_error",
          },
          { status: 400 }
        );
      }

      const gAddrEntry = applyDelegatedFreighterSignature(
        gAddressEntryTemplateXdr,
        signedAuthEntryBase64,
        signerAddress
      );

      const expectedDigestHex = computeAuthDigest(
        smartAccountEntry,
        config.networkPassphrase,
        contextRuleIds
      ).toString("hex");
      const signedDigestHex = delegatedCheckAuthArgHex(gAddrEntry);
      if (signedDigestHex !== expectedDigestHex) {
        return NextResponse.json(
          {
            error:
              "Delegated auth entry digest does not match the smart-account auth payload. Re-run prepare-sign or build-swap and sign again.",
            code: "auth_digest_mismatch",
            expectedDigestHex,
            signedDigestHex,
          },
          { status: 400 }
        );
      }

      entries[resolvedSmartAccountIndex] = smartAccountEntry;

      let delegatedEntryApplied = false;
      for (let i = 0; i < entries.length; i++) {
        if (i === resolvedSmartAccountIndex) continue;
        if (addressStringFromCredentials(entries[i]) === signerAddress) {
          entries[i] = gAddrEntry;
          delegatedEntryApplied = true;
          break;
        }
      }
      if (!delegatedEntryApplied) {
        entries.push(gAddrEntry);
      }

      const txWithAuth = rebuildTxWithAuthEntries(tx, config.networkPassphrase, entries);
      return finalize(txWithAuth);
    }

    if (!gAddressEntryTemplateXdr || !signedAuthEntryBase64 || !signerAddress) {
      return NextResponse.json(
        {
          error:
            "Missing required fields for Freighter submit: gAddressEntryTemplateXdr, signedAuthEntryBase64, signerAddress",
        },
        { status: 400 }
      );
    }

    if (signerAddress === bundlerPublicKey) {
      return NextResponse.json(
        {
          error:
            "signerAddress must be your Freighter G-address, not the bundler fee-payer.",
          code: "validation_error",
        },
        { status: 400 }
      );
    }

    const gAddrEntry = applyDelegatedFreighterSignature(
      gAddressEntryTemplateXdr,
      signedAuthEntryBase64,
      signerAddress
    );

    let freighterEntryApplied = false;
    for (let i = 0; i < entries.length; i++) {
      if (i === smartAccountAuthEntryIndex) continue;
      if (addressStringFromCredentials(entries[i]) === signerAddress) {
        entries[i] = gAddrEntry;
        freighterEntryApplied = true;
        break;
      }
    }
    if (!freighterEntryApplied) {
      entries.push(gAddrEntry);
    }

    const needsBundlerSign =
      delegatedGAuthEntrySynthesized === true ||
      entries.some((e) => isBundlerDelegatedCheckAuthEntry(e, bundlerPublicKey));

    if (needsBundlerSign) {
      const smartAccountAddr = addressStringFromCredentials(smartAccountEntry);
      if (smartAccountAddr) {
        try {
          const contextRuleIds = resolveContextRuleIds(smartAccountEntry, contextRuleId);
          const expectedDigestHex = computeAuthDigest(
            smartAccountEntry,
            config.networkPassphrase,
            contextRuleIds
          ).toString("hex");
          const bundlerIdx = entries.findIndex(
            (e, i) =>
              i !== smartAccountAuthEntryIndex &&
              addressStringFromCredentials(e) === bundlerPublicKey
          );
          if (
            bundlerIdx < 0 ||
            !bundlerEntryDigestMatches(entries[bundlerIdx], expectedDigestHex)
          ) {
            upsertBundlerDelegatedEntry(
              entries,
              smartAccountAuthEntryIndex,
              bundlerPublicKey,
              smartAccountAddr,
              config.networkPassphrase,
              contextRuleIds
            );
          }
        } catch {
          // Freighter path: fall back to signing existing bundler rows only.
        }
      }

      signDelegatedEntriesInPlace(
        entries,
        smartAccountAuthEntryIndex,
        config.networkPassphrase
      );
    }

    const txWithAuth = rebuildTxWithAuthEntries(tx, config.networkPassphrase, entries);
    return finalize(txWithAuth);
  } catch (error) {
    console.error("Error submitting delegated transaction:", error);
    const msg = error instanceof Error ? error.message : "Failed to submit transaction";
    if (error instanceof ApiRequestError && error.code === "SIGNER_MISMATCH") {
      return NextResponse.json({ error: msg, code: error.code }, { status: error.status });
    }
    if (msg.includes("Auth validation failed")) {
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
