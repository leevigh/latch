import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import {
  StrKey,
  Keypair,
  TransactionBuilder,
  Networks,
  xdr,
  rpc,
  Contract,
  Address,
  scValToNative,
  Account,
} from "@stellar/stellar-sdk";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  factoryAddress: process.env.NEXT_PUBLIC_FACTORY_ADDRESS,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

// In-memory cache keyed by G-address
const cache: Map<string, string> = new Map();

function deriveSalt(gAddress: string): Buffer {
  return Buffer.from(
    crypto.createHash("sha256").update(gAddress + "freighter-delegated-v1").digest("hex"),
    "hex"
  );
}

/**
 * AccountInitParams with AccountSignerInit::Delegated(g_address).
 *
 * Rust enum XDR: scvVec([ scvSymbol("Delegated"), address.toScVal() ])
 */
function buildParamsMap(gAddress: string, salt: Buffer): xdr.ScVal {
  const delegatedSigner = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("Delegated"),
    new Address(gAddress).toScVal(),
  ]);

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("account_salt"),
      val: xdr.ScVal.scvBytes(salt),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvVec([delegatedSigner]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("threshold"),
      val: xdr.ScVal.scvVoid(),
    }),
  ]);
}

async function predictAddress(
  server: rpc.Server,
  networkPassphrase: string,
  factoryAddress: string,
  paramsMap: xdr.ScVal
): Promise<string> {
  const dummyKp = Keypair.random();
  const dummyAccount = new Account(dummyKp.publicKey(), "0");
  const factory = new Contract(factoryAddress);

  const tx = new TransactionBuilder(dummyAccount, { fee: "100", networkPassphrase })
    .addOperation(factory.call("get_account_address", paramsMap))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`get_account_address simulation failed: ${sim.error}`);
  }
  return scValToNative(sim.result!.retval);
}

async function fundIfNeeded(gAddress: string): Promise<void> {
  try {
    const res = await fetch(`https://horizon-testnet.stellar.org/accounts/${gAddress}`);
    if (res.ok) return;
  } catch { /* ignore */ }
  const res = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(gAddress)}`);
  if (!res.ok) throw new Error(`Friendbot failed: ${res.statusText}`);
}

// ─── GET: check if already deployed ──────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const gAddress = searchParams.get("gAddress");

    if (!gAddress || !StrKey.isValidEd25519PublicKey(gAddress)) {
      return NextResponse.json({ error: "Missing or invalid gAddress." }, { status: 400 });
    }

    if (cache.has(gAddress)) {
      return NextResponse.json({ deployed: true, smartAccountAddress: cache.get(gAddress) });
    }

    const config = getConfig();
    if (!config.factoryAddress) {
      return NextResponse.json({ error: "NEXT_PUBLIC_FACTORY_ADDRESS not configured." }, { status: 500 });
    }

    const server = new rpc.Server(config.rpcUrl);
    const salt = deriveSalt(gAddress);
    const paramsMap = buildParamsMap(gAddress, salt);
    const predictedAddress = await predictAddress(
      server, config.networkPassphrase, config.factoryAddress, paramsMap
    );

    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(predictedAddress).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );
    const { entries } = await server.getLedgerEntries(instanceKey);
    const deployed = entries.length > 0;
    if (deployed) cache.set(gAddress, predictedAddress);

    return NextResponse.json({ deployed, smartAccountAddress: predictedAddress });
  } catch (error) {
    console.error("Freighter account lookup error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Lookup failed" },
      { status: 500 }
    );
  }
}

// ─── POST: deploy via factory ─────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  try {
    const config = getConfig();
    if (!config.bundlerSecret) {
      return NextResponse.json({ error: "BUNDLER_SECRET not set." }, { status: 500 });
    }
    if (!config.factoryAddress) {
      return NextResponse.json({ error: "NEXT_PUBLIC_FACTORY_ADDRESS not set." }, { status: 500 });
    }

    const { gAddress } = await request.json();
    if (!gAddress || typeof gAddress !== "string" || !StrKey.isValidEd25519PublicKey(gAddress)) {
      return NextResponse.json(
        { error: "Invalid gAddress. Expected a valid Stellar G-address." },
        { status: 400 }
      );
    }

    if (cache.has(gAddress)) {
      return NextResponse.json({ smartAccountAddress: cache.get(gAddress), alreadyDeployed: true });
    }

    await fundIfNeeded(gAddress);

    const server = new rpc.Server(config.rpcUrl);
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);
    const salt = deriveSalt(gAddress);
    const paramsMap = buildParamsMap(gAddress, salt);
    const factory = new Contract(config.factoryAddress);

    const predictedAddress = await predictAddress(
      server, config.networkPassphrase, config.factoryAddress, paramsMap
    );

    const bundlerAccount = await server.getAccount(bundlerKeypair.publicKey());

    const createTx = new TransactionBuilder(bundlerAccount, {
      fee: "1500000",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(factory.call("create_account", paramsMap))
      .setTimeout(300)
      .build();

    const sim = await server.simulateTransaction(createTx);
    if (rpc.Api.isSimulationError(sim)) {
      throw new Error(`create_account simulation failed: ${sim.error}`);
    }

    const assembled = rpc.assembleTransaction(createTx, sim).build();
    assembled.sign(bundlerKeypair);

    const sendResult = await server.sendTransaction(assembled);
    if (sendResult.status === "ERROR") {
      throw new Error(`Factory create_account failed: ${sendResult.errorResult?.toXDR("base64")}`);
    }

    let smartAccountAddress: string | undefined;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const txResult = await server.getTransaction(sendResult.hash);
      if (txResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
      if (txResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const success = txResult as rpc.Api.GetSuccessfulTransactionResponse;
        if (success.returnValue) smartAccountAddress = scValToNative(success.returnValue);
        break;
      }
      throw new Error(`Factory deployment failed with status: ${txResult.status}`);
    }

    if (!smartAccountAddress) smartAccountAddress = predictedAddress;
    if (smartAccountAddress !== predictedAddress) {
      throw new Error(`Address mismatch: predicted=${predictedAddress} actual=${smartAccountAddress}`);
    }

    cache.set(gAddress, smartAccountAddress);
    return NextResponse.json({ smartAccountAddress, alreadyDeployed: false });
  } catch (error) {
    console.error("Freighter account deploy error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Deployment failed" },
      { status: 500 }
    );
  }
}
