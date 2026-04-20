import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import {
  StrKey,
  Keypair,
  TransactionBuilder,
  Networks,
  Operation,
  xdr,
  rpc,
  Address,
} from "@stellar/stellar-sdk";

const getTestnetConfig = () => {
  const config = {
    rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
    networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
    verifierAddress: process.env.NEXT_PUBLIC_VERIFIER_ADDRESS!,
    counterAddress: process.env.NEXT_PUBLIC_COUNTER_ADDRESS!,
    // Fallback to the current constructor-based smart account WASM if missing from .env
    smartAccountWasmHash: process.env.NEXT_PUBLIC_SMART_ACCOUNT_WASM_HASH || "c00f972cb8ed5eba151f4cd6e97519db679a7a31cc657838449b405fb9cf53c4",
    bundlerSecret: process.env.BUNDLER_SECRET!,
  };
  
  if (!config.bundlerSecret) {
    throw new Error("BUNDLER_SECRET environment variable is required");
  }
  if (!config.verifierAddress || !config.counterAddress || !config.smartAccountWasmHash) {
    throw new Error("Missing required contract addresses in environment variables");
  }
  
  return config;
};

// Simple in-memory cache to track deployed accounts
// In production, use a database
const deployedAccounts: Map<string, { smartAccountAddress: string; gAddress: string }> = new Map();

function buildConstructorArgs(publicKeyHex: string, verifierAddress: string): xdr.ScVal[] {
  const externalSigner = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    new Address(verifierAddress).toScVal(),
    xdr.ScVal.scvBytes(Buffer.from(publicKeyHex, "hex")),
  ]);

  return [
    xdr.ScVal.scvVec([externalSigner]),
    xdr.ScVal.scvMap([]),
  ];
}

// Derive Stellar G-address from Ed25519 public key bytes
function deriveGAddressFromPubkey(pubkeyHex: string): string {
  try {
    const pubkeyBytes = Buffer.from(pubkeyHex, "hex");
    // Use StrKey to encode raw Ed25519 public key bytes into G-address format
    const gAddress = StrKey.encodeEd25519PublicKey(pubkeyBytes);
    return gAddress;
  } catch (err) {
    console.error("Error deriving G-address:", err);
    throw new Error(`Failed to derive G-address from pubkey: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function POST(request: NextRequest) {
  try {
    const TESTNET_CONFIG = getTestnetConfig();
    const { publicKeyHex } = await request.json();

    if (!publicKeyHex || typeof publicKeyHex !== "string" || publicKeyHex.length !== 64) {
      return NextResponse.json(
        { error: "Invalid public key. Expected 64-character hex string." },
        { status: 400 }
      );
    }

    // Derive the user's Stellar G-address from their Phantom pubkey
    const userGAddress = deriveGAddressFromPubkey(publicKeyHex);
    console.log(`Derived G-address: ${userGAddress}`);

    // Check if already deployed for this pubkey
    if (deployedAccounts.has(publicKeyHex)) {
      const cached = deployedAccounts.get(publicKeyHex)!;
      return NextResponse.json({
        smartAccountAddress: cached.smartAccountAddress,
        gAddress: cached.gAddress,
        alreadyDeployed: true,
      });
    }

    // Generate deterministic salt from pubkey + version
    const SMART_ACCOUNT_VERSION = "v8-ed25519-verifier-fix";
    const saltHex = crypto.createHash("sha256").update(publicKeyHex + SMART_ACCOUNT_VERSION).digest("hex");
    const salt = Buffer.from(saltHex, "hex");
    const constructorArgs = buildConstructorArgs(publicKeyHex, TESTNET_CONFIG.verifierAddress);

    console.log(`Deploying smart account for pubkey: ${publicKeyHex}`);
    console.log(`Using salt: ${saltHex}`);

    // Initialize Stellar SDK
    const server = new rpc.Server(TESTNET_CONFIG.rpcUrl);
    const bundlerKeypair = Keypair.fromSecret(TESTNET_CONFIG.bundlerSecret);

    let smartAccountAddress: string;

    try {
      // Get bundler account
      const bundlerAccount = await server.getAccount(bundlerKeypair.publicKey());

      // Build deployment transaction
      const deployTx = new TransactionBuilder(bundlerAccount, {
        fee: "1000000",
        networkPassphrase: TESTNET_CONFIG.networkPassphrase,
      })
        .addOperation(
          Operation.createCustomContract({
            address: new Address(bundlerKeypair.publicKey()),
            wasmHash: Buffer.from(TESTNET_CONFIG.smartAccountWasmHash, "hex"),
            salt: salt,
            constructorArgs,
          })
        )
        .setTimeout(300)
        .build();

      // Simulate to get footprint and resource fees
      const simResult = await server.simulateTransaction(deployTx);

      if (rpc.Api.isSimulationError(simResult)) {
        throw new Error(`Deployment simulation failed: ${simResult.error}`);
      }

      // Assemble transaction with correct footprint
      const assembledTx = rpc.assembleTransaction(deployTx, simResult).build();
      assembledTx.sign(bundlerKeypair);

      // Submit deployment transaction
      const deployResult = await server.sendTransaction(assembledTx);

      if (deployResult.status === "ERROR") {
        throw new Error(`Deployment failed: ${deployResult.errorResult?.toXDR("base64")}`);
      }

      // Wait for transaction confirmation
      let deployTxResult: rpc.Api.GetTransactionResponse | undefined;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        deployTxResult = await server.getTransaction(deployResult.hash);
        if (deployTxResult.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
          break;
        }
      }

      if (!deployTxResult) {
        throw new Error("Transaction not found after polling");
      }

      if (deployTxResult.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        // Extract contract address from transaction result
        const result = deployTxResult as rpc.Api.GetSuccessfulTransactionResponse;
        const returnValue = result.returnValue;
        if (returnValue) {
          smartAccountAddress = Address.fromScVal(returnValue).toString();
          console.log(`Deployed smart account: ${smartAccountAddress}`);
        } else {
          throw new Error("No return value from deployment transaction");
        }
      } else if (deployTxResult.status === rpc.Api.GetTransactionStatus.FAILED) {
        // Contract might already exist - compute the expected address
        const contractIdPreimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: Address.fromString(bundlerKeypair.publicKey()).toScAddress(),
            salt: salt,
          })
        );
        const networkIdHash = crypto.createHash("sha256").update(TESTNET_CONFIG.networkPassphrase, "utf8").digest();
        const hashIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
          new xdr.HashIdPreimageContractId({
            networkId: networkIdHash,
            contractIdPreimage: contractIdPreimage,
          })
        );
        const contractIdHash = crypto.createHash("sha256").update(hashIdPreimage.toXDR()).digest();
        smartAccountAddress = StrKey.encodeContract(contractIdHash);
        console.log(`Smart account already exists: ${smartAccountAddress}`);
      } else {
        throw new Error(`Deployment transaction status: ${deployTxResult.status}`);
      }
    } catch (deployError: unknown) {
      const errorMessage = deployError instanceof Error ? deployError.message : String(deployError);
      // If contract already exists, compute the deterministic address
      if (errorMessage.includes("already exists") || errorMessage.includes("ExistingValue")) {
        const contractIdPreimage = xdr.ContractIdPreimage.contractIdPreimageFromAddress(
          new xdr.ContractIdPreimageFromAddress({
            address: Address.fromString(bundlerKeypair.publicKey()).toScAddress(),
            salt: salt,
          })
        );
        const networkIdHash = crypto.createHash("sha256").update(TESTNET_CONFIG.networkPassphrase, "utf8").digest();
        const hashIdPreimage = xdr.HashIdPreimage.envelopeTypeContractId(
          new xdr.HashIdPreimageContractId({
            networkId: networkIdHash,
            contractIdPreimage: contractIdPreimage,
          })
        );
        const contractIdHash = crypto.createHash("sha256").update(hashIdPreimage.toXDR()).digest();
        smartAccountAddress = StrKey.encodeContract(contractIdHash);
        console.log(`Smart account already exists (computed address): ${smartAccountAddress}`);
      } else {
        throw deployError;
      }
    }

    console.log(`✅ Smart account deployed with constructor signers`);

    // Cache the deployment
    deployedAccounts.set(publicKeyHex, { smartAccountAddress, gAddress: userGAddress });

    return NextResponse.json({
      smartAccountAddress,
      gAddress: userGAddress,
      verifierAddress: TESTNET_CONFIG.verifierAddress,
      counterAddress: TESTNET_CONFIG.counterAddress,
      alreadyDeployed: false,
    });
  } catch (error) {
    console.error("Error deploying smart account:", error);
    // Return more detailed error info for debugging
    const errorMessage = error instanceof Error ? error.message : "Failed to deploy smart account";
    const errorStack = error instanceof Error ? error.stack : undefined;
    return NextResponse.json(
      {
        error: errorMessage,
        details: errorStack,
        type: error?.constructor?.name
      },
      { status: 500 }
    );
  }
}

export async function GET() {
  const config = getTestnetConfig();
  return NextResponse.json({
    verifierAddress: config.verifierAddress,
    counterAddress: config.counterAddress,
    network: "testnet",
  });
}
