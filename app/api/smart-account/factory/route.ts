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

// Load configuration from environment variables
// Define configuration lazily using getters so we don't crash at module initialization
const getTestnetConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  factoryAddress: process.env.NEXT_PUBLIC_FACTORY_ADDRESS,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

// In-memory cache
const deployedAccounts: Map<string, { smartAccountAddress: string; gAddress: string }> = new Map();

// Shared: derives the deterministic salt used for both lookup and creation.
// Version bump = new address, ensuring this route always deploys a FRESH account
// via the factory (with the correct stellar_accounts WASM that includes __check_auth),
// rather than reusing an old address from the legacy latch-demo deploy that lacked it.
function deriveSalt(publicKeyHex: string): Buffer {
  const SMART_ACCOUNT_VERSION = "factory-v2";
  const saltHex = crypto.createHash("sha256").update(publicKeyHex + SMART_ACCOUNT_VERSION).digest("hex");
  return Buffer.from(saltHex, "hex");
}

// Shared: builds the AccountInitParams ScVal map
function buildParamsMap(publicKeyHex: string, salt: Buffer): xdr.ScVal {
  const signerStruct = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("key_data"),
      val: xdr.ScVal.scvBytes(Buffer.from(publicKeyHex, "hex")),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signer_kind"),
      // Soroban #[contracttype] enums serialize as ScVec([Symbol("VariantName")])
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Ed25519")]),
    }),
  ]);

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("account_salt"),
      val: xdr.ScVal.scvBytes(salt),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvVec([signerStruct]),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("threshold"),
      val: xdr.ScVal.scvVoid(),
    }),
  ]);
}

// ─── GET: look up whether a smart account is already deployed ─────────────────
// Uses get_account_address (simulation, free) then checks the ledger instance entry.
export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const publicKeyHex = searchParams.get("pubkey");

    if (!publicKeyHex || publicKeyHex.length !== 64) {
      return NextResponse.json(
        { error: "Missing or invalid pubkey query param (expected 64-char hex)." },
        { status: 400 }
      );
    }

    const config = getTestnetConfig();
    if (!config.factoryAddress) {
      return NextResponse.json({ error: "Factory address not configured." }, { status: 500 });
    }

    // Check in-memory cache first (fast path)
    if (deployedAccounts.has(publicKeyHex)) {
      const cached = deployedAccounts.get(publicKeyHex)!;
      return NextResponse.json({ deployed: true, smartAccountAddress: cached.smartAccountAddress });
    }

    const server = new rpc.Server(config.rpcUrl);
    const salt   = deriveSalt(publicKeyHex);
    const params = buildParamsMap(publicKeyHex, salt);

    // Simulate get_account_address — pure read, costs nothing
    // Use a random throwaway keypair as the tx source (same pattern as /api/counter)
    const dummyKp      = Keypair.random();
    const dummyAccount = new Account(dummyKp.publicKey(), "0");
    const contract = new Contract(config.factoryAddress);
    const lookupTx = new TransactionBuilder(dummyAccount, {
      fee: "100",
      networkPassphrase: config.networkPassphrase,
    })
      .addOperation(contract.call("get_account_address", params))
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(lookupTx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(`Address lookup simulation failed: ${simResult.error}`);
    }

    const predictedAddress: string = scValToNative(simResult.result!.retval);

    // Check whether the contract instance ledger entry exists at that address
    // ContractData(contract, ScvLedgerKeyContractInstance, Persistent) is the instance key.
    const instanceLedgerKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(predictedAddress).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );

    const { entries } = await server.getLedgerEntries(instanceLedgerKey);
    const deployed = entries.length > 0;

    if (deployed) {
      // Populate cache so POST can fast-path on subsequent calls
      const gAddress = deriveGAddressFromPubkey(publicKeyHex);
      deployedAccounts.set(publicKeyHex, { smartAccountAddress: predictedAddress, gAddress });
    }

    return NextResponse.json({ deployed, smartAccountAddress: predictedAddress });
  } catch (error) {
    console.error("Error looking up smart account:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Lookup failed" },
      { status: 500 }
    );
  }
}

function deriveGAddressFromPubkey(pubkeyHex: string): string {
  try {
    const pubkeyBytes = Buffer.from(pubkeyHex, "hex");
    return StrKey.encodeEd25519PublicKey(pubkeyBytes);
  } catch (err) {
    console.error("Error deriving G-address:", err);
    throw new Error(`Failed to derive G-address from pubkey: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function fundAccountIfNeeded(gAddress: string): Promise<void> {
  try {
    const horizonResponse = await fetch(`https://horizon-testnet.stellar.org/accounts/${gAddress}`);
    if (horizonResponse.ok) return;
  } catch (err) {}

  console.log(`Funding account ${gAddress} via Friendbot...`);
  const response = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(gAddress)}`);
  if (!response.ok) {
    throw new Error(`Failed to fund account: ${response.statusText}`);
  }
}

export async function POST(request: NextRequest) {
  try {
    const { publicKeyHex } = await request.json();

    if (!publicKeyHex || typeof publicKeyHex !== "string" || publicKeyHex.length !== 64) {
      return NextResponse.json(
        { error: "Invalid public key. Expected 64-character hex string." },
        { status: 400 }
      );
    }

    const userGAddress = deriveGAddressFromPubkey(publicKeyHex);
    console.log(`Derived G-address: ${userGAddress}`);

    if (deployedAccounts.has(publicKeyHex)) {
      const cached = deployedAccounts.get(publicKeyHex)!;
      return NextResponse.json({
        smartAccountAddress: cached.smartAccountAddress,
        gAddress: cached.gAddress,
        alreadyDeployed: true,
      });
    }

    await fundAccountIfNeeded(userGAddress);

    console.log(`Deploying smart account for pubkey: ${publicKeyHex}`);

    const config = getTestnetConfig();
    
    if (!config.bundlerSecret) {
      throw new Error("BUNDLER_SECRET environment variable is required and currently missing from .env.");
    }
    if (!config.factoryAddress) {
      throw new Error("Missing NEXT_PUBLIC_FACTORY_ADDRESS in environment variables.");
    }

    const server = new rpc.Server(config.rpcUrl);
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);

    const salt     = deriveSalt(publicKeyHex);
    const paramsMap = buildParamsMap(publicKeyHex, salt);
    const contract  = new Contract(config.factoryAddress);
    const bundlerAccount = await server.getAccount(bundlerKeypair.publicKey());

    let smartAccountAddress: string = "";

    const deployTx = new TransactionBuilder(bundlerAccount, {
      fee: "1500000",
      networkPassphrase: config.networkPassphrase,
    })
    .addOperation(
      contract.call("create_account", paramsMap)
    )
    .setTimeout(300)
    .build();

    console.log("Simulating factory create_account...");
    const simResult = await server.simulateTransaction(deployTx);

    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(`Factory deployment simulation failed: ${simResult.error}`);
    }

    // The simulation succeeded — extract the Smart Account address from the sim result.
    // scValToNative correctly handles scvAddress ScVal types, returning the C-address string.
    try {
      const returnValNative = scValToNative(simResult.result!.retval);
      smartAccountAddress = returnValNative;
      console.log(`Simulation preview. Predicted Account: ${smartAccountAddress}`);
    } catch(e) {
      console.log("Could not pre-read address from simulation — will parse from settled tx.");
    }

    const assembledTx = rpc.assembleTransaction(deployTx, simResult).build();
    assembledTx.sign(bundlerKeypair);

    const deployResult = await server.sendTransaction(assembledTx);

    if (deployResult.status === "ERROR") {
      throw new Error(`Factory deployment failed: ${deployResult.errorResult?.toXDR("base64")}`);
    }

    let deployTxResult: rpc.Api.GetTransactionResponse | undefined;
    for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        deployTxResult = await server.getTransaction(deployResult.hash);
        if (deployTxResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
           break;
        }
    }

    if (!deployTxResult) throw new Error("Transaction not found after polling");

    if (deployTxResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
      const result = deployTxResult as rpc.Api.GetSuccessfulTransactionResponse;
      if (result.returnValue) {
        // Use scValToNative — the factory returns a Soroban Address ScVal
        smartAccountAddress = scValToNative(result.returnValue);
      }
      console.log(`Deployment successful via factory: ${smartAccountAddress}`);
    } else {
        throw new Error(`Factory deployment transaction status: ${deployTxResult.status}`);
    }

    deployedAccounts.set(publicKeyHex, { smartAccountAddress: smartAccountAddress!, gAddress: userGAddress });

    return NextResponse.json({
      smartAccountAddress: smartAccountAddress!,
      gAddress: userGAddress,
      factoryAddress: config.factoryAddress!,
      alreadyDeployed: false,
    });
  } catch (error) {
    console.error("Error creating via factory:", error);
    const errorMessage = error instanceof Error ? error.message : "Failed to deploy smart account via factory";
    const errorStack = error instanceof Error ? error.stack : undefined;
    return NextResponse.json(
      { error: errorMessage, details: errorStack, type: error?.constructor?.name },
      { status: 500 }
    );
  }
}
