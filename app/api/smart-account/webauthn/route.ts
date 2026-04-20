import { NextRequest, NextResponse } from "next/server";
import * as crypto from "crypto";
import {
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

/**
 * WebAuthn smart account factory route.
 *
 * Deploys a smart account via the factory with a WebAuthn (P-256) signer.
 * keyData = 65-byte uncompressed P-256 pubkey || credentialId bytes.
 *
 * GET  ?credentialId=<base64url> — look up whether account is deployed
 * POST { keyDataHex, credentialId } — deploy via factory
 */

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  factoryAddress: process.env.NEXT_PUBLIC_FACTORY_ADDRESS,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

// In-memory cache keyed by credentialId (base64url)
const cache: Map<string, string> = new Map();

/**
 * Deterministic account_salt: sha256(keyDataHex + version).
 * Keyed on keyData (pubkey + credentialId) so each passkey gets a unique address.
 */
function deriveSalt(keyDataHex: string): Buffer {
  const saltHex = crypto
    .createHash("sha256")
    .update(keyDataHex + "webauthn-v1")
    .digest("hex");
  return Buffer.from(saltHex, "hex");
}

/**
 * AccountInitParams for a WebAuthn external signer.
 *
 * Rust shape:
 *   AccountSignerInit::External(ExternalSignerInit {
 *     signer_kind: SignerKind::WebAuthn,
 *     key_data: Bytes,        // 65-byte pubkey || credentialId
 *   })
 *
 * XDR encoding of AccountSignerInit::External(ExternalSignerInit):
 *   scvVec([ scvSymbol("External"), scvMap({ key_data, signer_kind }) ])
 */
function buildParamsMap(keyDataHex: string, salt: Buffer): xdr.ScVal {
  const signerStruct = xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("key_data"),
      val: xdr.ScVal.scvBytes(Buffer.from(keyDataHex, "hex")),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signer_kind"),
      val: xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("WebAuthn")]),
    }),
  ]);

  const externalSigner = xdr.ScVal.scvVec([
    xdr.ScVal.scvSymbol("External"),
    signerStruct,
  ]);

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("account_salt"),
      val: xdr.ScVal.scvBytes(salt),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("signers"),
      val: xdr.ScVal.scvVec([externalSigner]),
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

  const tx = new TransactionBuilder(dummyAccount, {
    fee: "100",
    networkPassphrase,
  })
    .addOperation(factory.call("get_account_address", paramsMap))
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`get_account_address simulation failed: ${sim.error}`);
  }

  return scValToNative(sim.result!.retval);
}

// ─── GET: look up existing account ───────────────────────────────────────────

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const credentialId = searchParams.get("credentialId");
    const keyDataHex = searchParams.get("keyDataHex");

    if (!credentialId || !keyDataHex) {
      return NextResponse.json(
        { error: "Missing credentialId or keyDataHex query params." },
        { status: 400 }
      );
    }

    if (cache.has(credentialId)) {
      return NextResponse.json({ deployed: true, smartAccountAddress: cache.get(credentialId) });
    }

    const config = getConfig();
    if (!config.factoryAddress) {
      return NextResponse.json({ error: "NEXT_PUBLIC_FACTORY_ADDRESS not configured." }, { status: 500 });
    }

    const server = new rpc.Server(config.rpcUrl);
    const salt = deriveSalt(keyDataHex);
    const paramsMap = buildParamsMap(keyDataHex, salt);
    const predictedAddress = await predictAddress(
      server, config.networkPassphrase, config.factoryAddress, paramsMap
    );

    // Check ledger for instance entry
    const instanceKey = xdr.LedgerKey.contractData(
      new xdr.LedgerKeyContractData({
        contract: new Address(predictedAddress).toScAddress(),
        key: xdr.ScVal.scvLedgerKeyContractInstance(),
        durability: xdr.ContractDataDurability.persistent(),
      })
    );
    const { entries } = await server.getLedgerEntries(instanceKey);
    const deployed = entries.length > 0;

    if (deployed) cache.set(credentialId, predictedAddress);

    return NextResponse.json({ deployed, smartAccountAddress: predictedAddress });
  } catch (error) {
    console.error("WebAuthn account lookup error:", error);
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

    const { keyDataHex, credentialId } = await request.json();

    if (!keyDataHex || typeof keyDataHex !== "string" || keyDataHex.length < 132) {
      // 65 bytes = 130 hex chars minimum (pubkey only); must be > 65 bytes so > 132 hex chars
      return NextResponse.json(
        { error: "keyDataHex must be at least 132 hex chars (65-byte pubkey + credentialId)." },
        { status: 400 }
      );
    }
    if (!credentialId || typeof credentialId !== "string") {
      return NextResponse.json({ error: "credentialId is required." }, { status: 400 });
    }

    if (cache.has(credentialId)) {
      return NextResponse.json({
        smartAccountAddress: cache.get(credentialId),
        alreadyDeployed: true,
      });
    }

    const server = new rpc.Server(config.rpcUrl);
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);
    const salt = deriveSalt(keyDataHex);
    const paramsMap = buildParamsMap(keyDataHex, salt);
    const factory = new Contract(config.factoryAddress);

    // Predict address first for the determinism check
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
        if (success.returnValue) {
          smartAccountAddress = scValToNative(success.returnValue);
        }
        break;
      }
      throw new Error(`Factory deployment failed with status: ${txResult.status}`);
    }

    if (!smartAccountAddress) {
      smartAccountAddress = predictedAddress;
    }

    if (smartAccountAddress !== predictedAddress) {
      throw new Error(
        `Deterministic address mismatch: predicted=${predictedAddress} actual=${smartAccountAddress}`
      );
    }

    cache.set(credentialId, smartAccountAddress);

    return NextResponse.json({
      smartAccountAddress,
      alreadyDeployed: false,
    });
  } catch (error) {
    console.error("WebAuthn account deploy error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Deployment failed" },
      { status: 500 }
    );
  }
}
