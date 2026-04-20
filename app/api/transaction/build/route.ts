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
  Account,
  scValToNative,
} from "@stellar/stellar-sdk";
import { assembleTransaction } from "@stellar/stellar-sdk/rpc";
import { hashSorobanAuthPayload } from "@/lib/soroban-auth-payload";
import {
  addressStringFromCredentials,
  classifyAuthEntryRole,
  credentialSwitchName,
  normalizeAuthEntries,
  rootInvocationSummary,
  setAddressCredentialExpiration,
} from "@/lib/soroban-auth-entries";
import { buildUnsignedDelegatedGCheckAuthEntry } from "@/lib/delegated-native-auth-entry";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  counterAddress: process.env.NEXT_PUBLIC_COUNTER_ADDRESS || "CBRCNPTZ7YPP5BCGF42QSUWPYZQW6OJDPNQ4HDEYO7VI5Z6AVWWNEZ2U",
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

export async function POST(request: NextRequest) {
  const TESTNET_CONFIG = getConfig();

  if (!TESTNET_CONFIG.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const bundlerKeypair = Keypair.fromSecret(TESTNET_CONFIG.bundlerSecret);
    const server = new rpc.Server(TESTNET_CONFIG.rpcUrl);
    const { smartAccountAddress, signerG } = await request.json();

    if (!smartAccountAddress || typeof smartAccountAddress !== "string") {
      return NextResponse.json(
        { error: "Missing smartAccountAddress" },
        { status: 400 }
      );
    }

    // Discover the context rule id that applies to calling the counter contract.
    // Many smart accounts have multiple context rules; hardcoding 0 can lead to auth failure.
    let contextRuleId = 0;
    let contextRuleDiscovery: "matched" | "fallback" = "fallback";
    try {
      const smartAccount = new Contract(smartAccountAddress);
      const dummyKp = Keypair.random();
      const dummyAccount = new Account(dummyKp.publicKey(), "0");

      const countTx = new TransactionBuilder(dummyAccount, {
        fee: "100",
        networkPassphrase: TESTNET_CONFIG.networkPassphrase,
      })
        .addOperation(smartAccount.call("get_context_rules_count"))
        .setTimeout(30)
        .build();

      const countSim = await server.simulateTransaction(countTx);
      if (rpc.Api.isSimulationSuccess(countSim)) {
        const count = Number(scValToNative(countSim.result!.retval));
        for (let id = 0; id < count; id++) {
          const ruleTx = new TransactionBuilder(dummyAccount, {
            fee: "100",
            networkPassphrase: TESTNET_CONFIG.networkPassphrase,
          })
            .addOperation(smartAccount.call("get_context_rule", xdr.ScVal.scvU32(id)))
            .setTimeout(30)
            .build();
          const ruleSim = await server.simulateTransaction(ruleTx);
          if (!rpc.Api.isSimulationSuccess(ruleSim)) continue;
          const ruleNative: any = scValToNative(ruleSim.result!.retval);
          const ctxType = ruleNative?.context_type ?? ruleNative?.contextType ?? ruleNative?.context;
          const isCallCounter =
            ctxType &&
            typeof ctxType === "object" &&
            (ctxType.CallContract === TESTNET_CONFIG.counterAddress || ctxType.callContract === TESTNET_CONFIG.counterAddress);
          if (isCallCounter) {
            contextRuleId = id;
            contextRuleDiscovery = "matched";
            break;
          }
        }
      }
    } catch {
      contextRuleDiscovery = "fallback";
    }

    // Build the transaction using bundler account as source (pays fees, signs envelope)
    let account;
    try {
      account = await server.getAccount(bundlerKeypair.publicKey());
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      if (msg.includes("Account not found")) {
        await fundAccountIfNeeded(bundlerKeypair.publicKey());
        account = await server.getAccount(bundlerKeypair.publicKey());
      } else {
        throw e;
      }
    }
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

    const authEntriesRaw = simResult.result?.auth;
    const entries = normalizeAuthEntries(authEntriesRaw);
    if (entries.length === 0) {
      throw new Error("No auth entries in simulation result");
    }

    const latestLedger = simResult.latestLedger;
    const validUntilLedger = setAddressCredentialExpiration(entries, latestLedger, 60);

    const signerGStr =
      typeof signerG === "string" && signerG.startsWith("G") ? signerG : null;

    let smartAccountAuthEntryIndex = -1;
    const delegatedNativeAuthEntryIndices: number[] = [];
    for (let i = 0; i < entries.length; i++) {
      const role = classifyAuthEntryRole(entries[i], smartAccountAddress, signerGStr);
      if (role === "smart_account_custom" && smartAccountAuthEntryIndex < 0) {
        smartAccountAuthEntryIndex = i;
      }
      if (role === "delegated_native") delegatedNativeAuthEntryIndices.push(i);
    }

    if (smartAccountAuthEntryIndex < 0) {
      throw new Error(
        "No SorobanAuthorizationEntry matches smartAccountAddress credentials; cannot build auth digest."
      );
    }

    const smartAccountAuthEntry = entries[smartAccountAuthEntryIndex];

    // 32-byte Soroban auth payload for the smart-account row (also the arg to `__check_auth` for Delegated(G) host auth).
    const signaturePayload = hashSorobanAuthPayload(
      smartAccountAuthEntry,
      TESTNET_CONFIG.networkPassphrase
    );

    // OpenZeppelin Delegated(G): `require_auth_for_args((auth_digest,))` is NOT in simulation `result.auth`.
    // Append the unsigned G row; client signs via Freighter `signBlob` on hashSorobanAuthPayload for that row (not `signAuthEntry`).
    let delegatedGAuthEntrySynthesized = false;
    if (signerGStr && delegatedNativeAuthEntryIndices.length === 0) {
      entries.push(
        buildUnsignedDelegatedGCheckAuthEntry({
          smartAccountAddress,
          signerG: signerGStr,
          authPayloadHash: Buffer.from(signaturePayload),
          signatureExpirationLedger: validUntilLedger,
        })
      );
      delegatedNativeAuthEntryIndices.push(entries.length - 1);
      delegatedGAuthEntrySynthesized = true;
    }

    if (process.env.DEBUG_SOROBAN_AUTH === "1") {
      console.log(
        "[DEBUG_SOROBAN_AUTH] build: authCount=%s smartAccountIndex=%s delegatedIndices=%s synthesizedG=%s contextRule=%s discovery=%s",
        entries.length,
        smartAccountAuthEntryIndex,
        JSON.stringify(delegatedNativeAuthEntryIndices),
        delegatedGAuthEntrySynthesized,
        contextRuleId,
        contextRuleDiscovery
      );
      entries.forEach((e, i) => {
        const credAddr = addressStringFromCredentials(e);
        const role = classifyAuthEntryRole(e, smartAccountAddress, signerGStr);
        console.log(
          "[DEBUG_SOROBAN_AUTH] build entry[%s] credential=%s credAddress=%s root=%s role=%s",
          i,
          credentialSwitchName(e),
          credAddr ?? "(none)",
          rootInvocationSummary(e),
          role
        );
      });
    }

    // Merge simulation footprint into tx (required for valid Soroban auth context)
    const assembledBuilder = assembleTransaction(tx, simResult);
    assembledBuilder.clearOperations();
    const origOp = tx.operations[0] as Operation.InvokeHostFunction;
    assembledBuilder.addOperation(
      Operation.invokeHostFunction({
        source: origOp.source,
        func: origOp.func,
        auth: entries,
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
    const authDigestBase64 = authDigest.toString("base64");

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

    const delegatedNativeSignBlobPayloadsBase64 = delegatedNativeAuthEntryIndices.map((idx) =>
      Buffer.from(hashSorobanAuthPayload(entries[idx], TESTNET_CONFIG.networkPassphrase)).toString(
        "base64"
      )
    );

    return NextResponse.json({
      txXdr: assembledTx.toXDR(),
      authEntryXdr: smartAccountAuthEntry.toXDR("base64"),
      authEntriesXdr: entries.map((e) => e.toXDR("base64")),
      smartAccountAuthEntryIndex,
      delegatedNativeAuthEntryIndices,
      delegatedNativeSignBlobPayloadsBase64,
      delegatedGAuthEntrySynthesized,
      contextRuleId,
      contextRuleDiscovery,
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
