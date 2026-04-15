import { NextRequest, NextResponse } from "next/server";
import {
  Contract,
  TransactionBuilder,
  Networks,
  Address,
  xdr,
  rpc,
  Keypair,
  Account,
  scValToNative,
  Operation,
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
 * Build tx that calls the Smart Account's `execute(target, target_fn, target_args)`,
 * instead of calling the target contract directly.
 *
 * This aligns with OZ `ExecutionEntryPoint` where `execute()` does:
 *   current_contract_address().require_auth();
 *   invoke_contract(target, target_fn, target_args);
 */
export async function POST(request: NextRequest) {
  const config = getConfig();
  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);
    const server = new rpc.Server(config.rpcUrl);
    const { smartAccountAddress } = await request.json();

    if (!smartAccountAddress || typeof smartAccountAddress !== "string") {
      return NextResponse.json({ error: "Missing smartAccountAddress" }, { status: 400 });
    }

    let bundlerAccount;
    try {
      bundlerAccount = await server.getAccount(bundlerKeypair.publicKey());
    } catch (e: any) {
      // Common on fresh testnet setups: bundler isn't funded yet.
      const msg = String(e?.message ?? e);
      if (msg.includes("Account not found")) {
        await fundAccountIfNeeded(bundlerKeypair.publicKey());
        bundlerAccount = await server.getAccount(bundlerKeypair.publicKey());
      } else {
        throw e;
      }
    }
    const smartAccount = new Contract(smartAccountAddress);

    // Discover an appropriate context rule id for the `execute` call context.
    // The auth context for smart-account authorization here is a Contract context to the smart account itself
    // (fn_name = "execute"), so a matching rule is typically CallContract(smartAccountAddress) or Default.
    let executeContextRuleId: number | undefined;
    try {
      const dummyKp = Keypair.random();
      const dummyAccount = new Account(dummyKp.publicKey(), "0");

      const countTx = new TransactionBuilder(dummyAccount, {
        fee: "100",
        networkPassphrase: config.networkPassphrase,
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
            networkPassphrase: config.networkPassphrase,
          })
            .addOperation(smartAccount.call("get_context_rule", xdr.ScVal.scvU32(id)))
            .setTimeout(30)
            .build();

          const ruleSim = await server.simulateTransaction(ruleTx);
          if (!rpc.Api.isSimulationSuccess(ruleSim)) continue;

          const ruleNative: any = scValToNative(ruleSim.result!.retval);
          const ctxType = ruleNative?.context_type ?? ruleNative?.contextType ?? ruleNative?.context;
          const isDefault = ctxType === "Default" || (ctxType && typeof ctxType === "object" && "Default" in ctxType);
          const isCallContract =
            ctxType &&
            typeof ctxType === "object" &&
            (ctxType.CallContract === smartAccountAddress || ctxType.callContract === smartAccountAddress);

          if (isDefault || isCallContract) {
            executeContextRuleId = id;
            break;
          }
        }
      }
    } catch {
      // Non-fatal; client can fall back to rule 0.
    }

    // Forwarded call: counter.increment(caller = smartAccount)
    const target = new Address(config.counterAddress).toScVal();
    const targetFn = xdr.ScVal.scvSymbol("increment");
    const targetArgs = xdr.ScVal.scvVec([new Address(smartAccountAddress).toScVal()]);

    const tx = new TransactionBuilder(bundlerAccount, {
      fee: "1000000",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(
        smartAccount.call(
          "execute",
          target,
          targetFn,
          targetArgs
        )
      )
      .setTimeout(300)
      .build();

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

    const parsedAuthEntries: xdr.SorobanAuthorizationEntry[] = authEntries.map((e: any) =>
      typeof e === "string" ? xdr.SorobanAuthorizationEntry.fromXDR(e, "base64") : (e as xdr.SorobanAuthorizationEntry)
    );

    const getAddr = (e: xdr.SorobanAuthorizationEntry): string | undefined => {
      try {
        const creds = e.credentials();
        if (creds.switch().name !== "sorobanCredentialsAddress") return undefined;
        return Address.fromScAddress(creds.address().address()).toString();
      } catch {
        return undefined;
      }
    };

    const smartAccountAuthEntry =
      parsedAuthEntries.find((e) => getAddr(e) === smartAccountAddress) ?? parsedAuthEntries[0];

    // Delegated/native signing: authorize the exact invocation tree that the tx requires.
    // This must come from simulation; do not synthesize or reconstruct it client-side.
    const delegatedInvocationXdr = smartAccountAuthEntry.rootInvocation().toXDR("base64");

    const signaturePayload = hashSorobanAuthPayload(smartAccountAuthEntry, config.networkPassphrase);

    const credentials = smartAccountAuthEntry.credentials().address();
    const latestLedger = simResult.latestLedger;
    const validUntilLedger = latestLedger + 60;
    credentials.signatureExpirationLedger(validUntilLedger);

    const assembledBuilder = assembleTransaction(tx, simResult);
    assembledBuilder.clearOperations();
    const origOp = tx.operations[0] as Operation.InvokeHostFunction;
    assembledBuilder.addOperation(
      Operation.invokeHostFunction({
        source: origOp.source,
        func: origOp.func,
        auth: [smartAccountAuthEntry],
      })
    );
    const assembledTx = assembledBuilder.build();

    return NextResponse.json({
      txXdr: assembledTx.toXDR(),
      authEntryXdr: smartAccountAuthEntry.toXDR("base64"),
      signaturePayloadHex: signaturePayload.toString("hex"),
      validUntilLedger,
      latestLedger: simResult.latestLedger,
      executeContextRuleId,
      // Freighter delegated signing: authorize this exact invocation tree.
      delegatedInvocationXdr,
    });
  } catch (error) {
    console.error("Error building execute transaction:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build transaction" },
      { status: 500 }
    );
  }
}

