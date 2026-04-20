import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
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
  counterAddress:
    process.env.NEXT_PUBLIC_COUNTER_ADDRESS ||
    "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U",
  bundlerSecret: process.env.BUNDLER_SECRET,
});

/**
 * AuthPayload XDR for a Delegated signer.
 *
 * Rust type:
 *   AuthPayload {
 *     signers: Map<Signer, Bytes>,       // Signer::Delegated(addr) -> empty bytes
 *     context_rule_ids: Vec<u32>,        // [0]
 *   }
 *
 * Signer::Delegated(addr) XDR: scvVec([ scvSymbol("Delegated"), addr.toScVal() ])
 */
function buildDelegatedAuthPayload(gAddress: string): xdr.ScVal {
  const signerKey = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    new Address(gAddress).toScVal(),
  ]);

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("context_rule_ids"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: signerKey,
          val: xdr.ScVal.scvBytes(Buffer.alloc(0)), // empty sig_data for Delegated
        }),
      ]),
    }),
  ]);
}

export async function POST(request: NextRequest) {
  const config = getConfig();
  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);
    const server = new rpc.Server(config.rpcUrl);
    const { smartAccountAddress, gAddress } = await request.json();

    if (!smartAccountAddress || typeof smartAccountAddress !== "string") {
      return NextResponse.json({ error: "Missing smartAccountAddress" }, { status: 400 });
    }
    if (!gAddress || typeof gAddress !== "string") {
      return NextResponse.json({ error: "Missing gAddress" }, { status: 400 });
    }

    const bundlerAccount = await server.getAccount(bundlerKeypair.publicKey());
    const contract = new Contract(config.counterAddress);

    const tx = new TransactionBuilder(bundlerAccount, {
      fee: "1000000",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        contract.call("increment", new Address(smartAccountAddress).toScVal())
      )
      .setTimeout(300)
      .build();

    // Recording-mode simulation — discovers auth entries needed
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

    // Get the smart account auth entry (credentials = C-address)
    const rawEntry = typeof authEntries[0] === "string"
      ? xdr.SorobanAuthorizationEntry.fromXDR(authEntries[0], "base64")
      : authEntries[0] as xdr.SorobanAuthorizationEntry;

    const validUntilLedger = simResult.latestLedger + 60;
    const smartAccountCreds = rawEntry.credentials().address();
    smartAccountCreds.signatureExpirationLedger(validUntilLedger);

    // Assemble tx (merge simulation footprint) while preserving the auth entry
    const assembledBuilder = assembleTransaction(tx, simResult);
    assembledBuilder.clearOperations();
    const origOp = tx.operations[0] as Operation.InvokeHostFunction;
    assembledBuilder.addOperation(
      Operation.invokeHostFunction({
        source: origOp.source,
        func: origOp.func,
        auth: [rawEntry],
      })
    );
    const assembledTx = assembledBuilder.build();

    // Compute signaturePayload = sha256(soroban-auth preimage) for the smart account entry
    const signaturePayload = hashSorobanAuthPayload(rawEntry, config.networkPassphrase);

    // auth_digest = sha256(signaturePayload || context_rule_ids.to_xdr())
    // context_rule_ids = [0] — must match what's in the AuthPayload below
    const ruleIdsXdr = xdr.ScVal.scvVec([xdr.ScVal.scvU32(0)]).toXDR();
    const authDigest = hash(Buffer.concat([signaturePayload, Buffer.from(ruleIdsXdr)]));

    // Set AuthPayload as the signature on the smart account auth entry
    const authPayload = buildDelegatedAuthPayload(gAddress);
    smartAccountCreds.signature(authPayload);

    // Build the G-address auth entry for Freighter to sign.
    //
    // The smart account's __check_auth handles Delegated(gAddress) by calling:
    //   gAddress.require_auth_for_args((auth_digest,))
    //
    // In Soroban, require_auth_for_args from inside __check_auth means:
    // "gAddress must have authorized the current __check_auth call, with args = (auth_digest,)"
    //
    // So the G-address auth entry's rootInvocation must be:
    //   smartAccount.__check_auth(auth_digest)   ← NOT counter.increment(...)
    //
    // Freighter signs: sha256(HashIdPreimage with this invocation).
    // The Soroban host verifies the G-address entry's Ed25519 signature against that hash.
    const nonceBytes = crypto.randomBytes(8);
    const nonce = nonceBytes.readBigInt64BE(0) as unknown as xdr.Int64;

    // The invocation the G-address authorizes: smartAccount.__check_auth(auth_digest)
    const gAddrInvocation = new xdr.SorobanAuthorizedInvocation({
      function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
        new xdr.InvokeContractArgs({
          contractAddress: new Address(smartAccountAddress).toScAddress(),
          functionName: "__check_auth",
          args: [xdr.ScVal.scvBytes(authDigest)],
        })
      ),
      subInvocations: [],
    });

    const networkId = hash(Buffer.from(config.networkPassphrase));
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId,
        nonce,
        signatureExpirationLedger: validUntilLedger,
        invocation: gAddrInvocation,
      })
    );

    // Entry template — credentials.signature is scvVoid; submit-delegated fills it in.
    const gAddrEntry = new xdr.SorobanAuthorizationEntry({
      credentials: xdr.SorobanCredentials.sorobanCredentialsAddress(
        new xdr.SorobanAddressCredentials({
          address: new Address(gAddress).toScAddress(),
          nonce,
          signatureExpirationLedger: validUntilLedger,
          signature: xdr.ScVal.scvVoid(),
        })
      ),
      rootInvocation: gAddrInvocation,
    });

    return NextResponse.json({
      txXdr: assembledTx.toXDR(),
      smartAccountAuthEntryXdr: rawEntry.toXDR("base64"),
      gAddressPreimageXdr: preimage.toXDR("base64"),       // passed to Freighter's signAuthEntry
      gAddressEntryTemplateXdr: gAddrEntry.toXDR("base64"), // passed to submit-delegated
      authDigestHex: authDigest.toString("hex"),
      validUntilLedger,
    });
  } catch (error) {
    console.error("Error building delegated transaction:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build transaction" },
      { status: 500 }
    );
  }
}
