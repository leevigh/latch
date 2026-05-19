import { NextRequest, NextResponse } from "next/server";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import {
  discoverContextRule,
  hasMatchedCallContractRule,
} from "@/lib/soroban-context-rules";
import {
  buildAddContextRuleOperation,
  buildSignersVecForSetup,
} from "@/lib/soroban-setup-signers";
import {
  buildAuthTransaction,
  type SignerType,
} from "@/lib/soroban-transaction-build";
import { getAssetCatalog, resolveAsset, type CatalogAsset } from "@/lib/stellar-assets";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase:
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  bundlerSecret: process.env.BUNDLER_SECRET,
  ed25519Verifier: process.env.NEXT_PUBLIC_VERIFIER_ADDRESS,
  webauthnVerifier: process.env.NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS,
});

const SIGNER_TYPES = new Set<SignerType>(["passkey", "phantom", "freighter"]);

export async function POST(request: NextRequest) {
  const config = getConfig();

  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const body = await request.json();
    const {
      smartAccountAddress,
      signerType,
      assetId,
      assetIds,
      publicKeyHex,
      keyDataHex,
      gAddress,
    } = body;

    if (!smartAccountAddress || typeof smartAccountAddress !== "string") {
      return NextResponse.json({ error: "Missing smartAccountAddress" }, { status: 400 });
    }
    if (!signerType || !SIGNER_TYPES.has(signerType)) {
      return NextResponse.json(
        { error: "signerType must be passkey, phantom, or freighter" },
        { status: 400 }
      );
    }

    const catalog = getAssetCatalog(config.networkPassphrase);
    let assetsToConfigure = catalog;

    if (typeof assetId === "string" && assetId) {
      assetsToConfigure = [resolveAsset(config.networkPassphrase, assetId)];
    } else if (Array.isArray(assetIds) && assetIds.length > 0) {
      assetsToConfigure = assetIds.map((id: string) =>
        resolveAsset(config.networkPassphrase, id)
      );
    }

    const server = new rpc.Server(config.rpcUrl);

    const missingAssets: CatalogAsset[] = [];
    for (const asset of assetsToConfigure) {
      const { discovery } = await discoverContextRule(
        server,
        config.networkPassphrase,
        smartAccountAddress,
        asset.contractId
      );
      if (!hasMatchedCallContractRule(discovery)) {
        missingAssets.push(asset);
      }
    }

    if (missingAssets.length === 0) {
      return NextResponse.json({
        alreadyConfigured: true,
        message: "Context rules already exist for all requested assets.",
      });
    }

    const verifierAddress =
      signerType === "passkey"
        ? config.webauthnVerifier
        : config.ed25519Verifier;

    if (!verifierAddress && signerType !== "freighter") {
      return NextResponse.json(
        { error: "Verifier address not configured for this signer type." },
        { status: 500 }
      );
    }

    const signersVec = buildSignersVecForSetup({
      signerType,
      verifierAddress: verifierAddress ?? "",
      publicKeyHex,
      keyDataHex,
      gAddress,
    });

    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);

    const assetToConfigure = missingAssets[0]!;

    const buildResult = await buildAuthTransaction({
      server,
      networkPassphrase: config.networkPassphrase,
      bundlerKeypair,
      smartAccountAddress,
      targetContractId: assetToConfigure.contractId,
      buildOperationsOnSmartAccount: (smartAccount) => [
        buildAddContextRuleOperation(smartAccount, assetToConfigure, signersVec),
      ],
      signerType,
      signerG: gAddress,
      requireMatchedContextRule: false,
    });

    return NextResponse.json({
      ...buildResult,
      configuredAsset: {
        assetId: assetToConfigure.assetId,
        contractId: assetToConfigure.contractId,
      },
      remainingSetupCount: missingAssets.length - 1,
      instructions:
        "Sign and submit this setup transaction (one context rule). Repeat if remainingSetupCount > 0.",
    });
  } catch (error) {
    console.error("Error building setup-send-rules:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to build setup transaction" },
      { status: 500 }
    );
  }
}
