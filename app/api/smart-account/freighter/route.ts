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

const getTestnetConfig = () => {
  const config = {
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
    factoryAddress: process.env.NEXT_PUBLIC_FACTORY_ADDRESS!,
    bundlerSecret: process.env.BUNDLER_SECRET!,
  };

  if (!config.bundlerSecret) throw new Error("BUNDLER_SECRET environment variable is required");
  if (!config.factoryAddress) throw new Error("NEXT_PUBLIC_FACTORY_ADDRESS is required");

  return config;
};

// In-memory cache
const deployedAccounts: Map<string, { smartAccountAddress: string; gAddress: string }> = new Map();

async function fundAccountIfNeeded(gAddress: string): Promise<void> {
  try {
    const horizonResponse = await fetch(`https://horizon-testnet.stellar.org/accounts/${gAddress}`);
    if (horizonResponse.ok) return;
  } catch (e) {
    // ignore
  }

  const response = await fetch(`https://friendbot.stellar.org?addr=${encodeURIComponent(gAddress)}`);
  if (!response.ok) throw new Error(`Failed to fund account: ${response.statusText}`);
}

/** Same 32-byte pubkey hex as `/api/smart-account/factory` (Phantom path). */
function pubkeyHexFromGAddress(gAddress: string): string {
  return Buffer.from(StrKey.decodeEd25519PublicKey(gAddress)).toString("hex").toLowerCase();
}

/** Must match `app/api/smart-account/factory/route.ts` so the same factory accepts params. */
function deriveFactorySalt(publicKeyHex: string): Buffer {
  const SMART_ACCOUNT_VERSION = "factory-v2";
  const saltHex = crypto.createHash("sha256").update(publicKeyHex + SMART_ACCOUNT_VERSION).digest("hex");
  return Buffer.from(saltHex, "hex");
}

/**
 * Same `AccountInitParams` encoding as the factory route: External Ed25519 (key_data + signer_kind).
 * The deployed Latch factory expects this shape; `Delegated(G...)` vec encoding traps the VM.
 */
function buildAccountInitParamsMap(publicKeyHex: string, salt: Buffer): xdr.ScVal {
  const normalizedPubkeyHex = publicKeyHex.toLowerCase();
  const signerStruct = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("key_data"),
      val: xdr.ScVal.scvBytes(Buffer.from(normalizedPubkeyHex, "hex")),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signer_kind"),
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

async function getFactoryPredictedAddress(paramsMap: xdr.ScVal): Promise<string> {
  const config = getTestnetConfig();
  const server = new rpc.Server(config.rpcUrl);

  // Pure-read simulation: any source account works; use a dummy.
  const dummyKp = Keypair.random();
  const dummyAccount = new Account(dummyKp.publicKey(), "0");
  const factory = new Contract(config.factoryAddress);

  const lookupTx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(factory.call("get_account_address", paramsMap))
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(lookupTx);
  if (rpc.Api.isSimulationError(simResult)) {
    throw new Error(`Factory get_account_address simulation failed: ${simResult.error}`);
  }

  return scValToNative(simResult.result!.retval);
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const gAddress = searchParams.get("gAddress");
    if (!gAddress || !StrKey.isValidEd25519PublicKey(gAddress)) {
      return NextResponse.json(
        { error: "Missing or invalid gAddress query param (expected Stellar G... address)." },
        { status: 400 }
      );
    }

    if (deployedAccounts.has(gAddress)) {
      const cached = deployedAccounts.get(gAddress)!;
      return NextResponse.json({ deployed: true, smartAccountAddress: cached.smartAccountAddress });
    }

    const config = getTestnetConfig();
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);
    void bundlerKeypair; // bundler only used for POST; keep creation consistent with factory route behavior
    const pubkeyHex = pubkeyHexFromGAddress(gAddress);
    const salt = deriveFactorySalt(pubkeyHex);
    const paramsMap = buildAccountInitParamsMap(pubkeyHex, salt);
    const predictedAddress = await getFactoryPredictedAddress(paramsMap);

    const server = new rpc.Server(config.rpcUrl);
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
      deployedAccounts.set(gAddress, { smartAccountAddress: predictedAddress, gAddress });
    }

    return NextResponse.json({ deployed, smartAccountAddress: predictedAddress });
  } catch (error) {
    console.error("Error looking up Freighter smart account:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Lookup failed" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const TESTNET_CONFIG = getTestnetConfig();
    const body = await request.json();
    const gAddress = body?.gAddress;

    if (!gAddress || typeof gAddress !== "string" || !StrKey.isValidEd25519PublicKey(gAddress)) {
      return NextResponse.json(
        { error: "Invalid gAddress. Expected Stellar G... public key string." },
        { status: 400 }
      );
    }

    if (deployedAccounts.has(gAddress)) {
      const cached = deployedAccounts.get(gAddress)!;
      return NextResponse.json({
        smartAccountAddress: cached.smartAccountAddress,
        gAddress: cached.gAddress,
        alreadyDeployed: true,
      });
    }

    await fundAccountIfNeeded(gAddress);

    const pubkeyHex = pubkeyHexFromGAddress(gAddress);
    const salt = deriveFactorySalt(pubkeyHex);
    const paramsMap = buildAccountInitParamsMap(pubkeyHex, salt);

    const server = new rpc.Server(TESTNET_CONFIG.rpcUrl);
    const bundlerKeypair = Keypair.fromSecret(TESTNET_CONFIG.bundlerSecret);

    const bundlerAccount = await server.getAccount(bundlerKeypair.publicKey());

    // Deterministic-address check: get_account_address(params) must match create_account(params).
    const predictedAddress = await getFactoryPredictedAddress(paramsMap);

    const factory = new Contract(TESTNET_CONFIG.factoryAddress);

    // Single-step: call factory.create_account(params)
    const createTx = new TransactionBuilder(bundlerAccount, {
      fee: "1000000",
      networkPassphrase: TESTNET_CONFIG.networkPassphrase,
    })
      .addOperation(
        factory.call("create_account", paramsMap)
      )
      .setTimeout(300)
      .build();

    const createSim = await server.simulateTransaction(createTx);
    if (rpc.Api.isSimulationError(createSim)) {
      throw new Error(`Factory create_account simulation failed: ${createSim.error}`);
    }

    // Pre-read address from simulation if possible (should be the created account address)
    let smartAccountAddress: string | undefined;
    try {
      smartAccountAddress = scValToNative(createSim.result!.retval);
    } catch {}

    const assembledCreateTx = rpc.assembleTransaction(createTx, createSim).build();
    assembledCreateTx.sign(bundlerKeypair);
    const createResult = await server.sendTransaction(assembledCreateTx);
    if (createResult.status === "ERROR") {
      throw new Error(`Factory create_account failed: ${createResult.errorResult?.toXDR("base64")}`);
    }

    // Poll for confirmation
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      const txResult = await server.getTransaction(createResult.hash);
      if (txResult.status === rpc.Api.GetTransactionStatus.NOT_FOUND) continue;
      if (txResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        const success = txResult as rpc.Api.GetSuccessfulTransactionResponse;
        if (success.returnValue) {
          smartAccountAddress = scValToNative(success.returnValue);
        }
        break;
      }
      if (txResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        break;
      }
    }

    if (!smartAccountAddress) {
      // If we couldn't parse settled tx return value (rare), fall back to predicted address.
      smartAccountAddress = predictedAddress;
    }

    // Deterministic-address sanity: must match get_account_address(params)
    if (smartAccountAddress !== predictedAddress) {
      throw new Error(
        `Factory deterministic-address mismatch: get_account_address=${predictedAddress} create_account=${smartAccountAddress}`
      );
    }

    deployedAccounts.set(gAddress, { smartAccountAddress, gAddress });

    return NextResponse.json({
      smartAccountAddress,
      gAddress,
      factoryAddress: TESTNET_CONFIG.factoryAddress,
      alreadyDeployed: false,
    });
  } catch (error) {
    console.error("Error deploying Freighter smart account:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to deploy smart account" },
      { status: 500 }
    );
  }
}

