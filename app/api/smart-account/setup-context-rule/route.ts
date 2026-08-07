import { NextRequest, NextResponse } from "next/server";
import { Address, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import {
  discoverContextRule,
  hasMatchedCallContractRule,
} from "@/lib/soroban-context-rules";
import {
  CONTEXT_RULE_NAME_MAX_LEN,
  buildAddContextRuleForContractOperation,
  buildSignersVecForSetup,
} from "@/lib/soroban-setup-signers";
import {
  buildAuthTransaction,
  type SignerType,
} from "@/lib/soroban-transaction-build";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase:
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  bundlerSecret: process.env.BUNDLER_SECRET,
  ed25519Verifier: process.env.NEXT_PUBLIC_VERIFIER_ADDRESS,
  webauthnVerifier: process.env.NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS,
});

const SIGNER_TYPES = new Set<SignerType>(["passkey", "phantom", "freighter"]);

function defaultRuleName(contractId: string): string {
  // OZ max 20 chars — use short prefix + contract tail
  const tail = contractId.slice(-12);
  const name = `dapp-${tail}`;
  return name.length > CONTEXT_RULE_NAME_MAX_LEN
    ? name.slice(0, CONTEXT_RULE_NAME_MAX_LEN)
    : name;
}

/**
 * POST /api/smart-account/setup-context-rule
 * Add CallContract(targetContractId) for an arbitrary Soroban contract (dapp / non-catalog).
 */
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
      targetContractId,
      name,
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
    if (!targetContractId || typeof targetContractId !== "string") {
      return NextResponse.json({ error: "Missing targetContractId" }, { status: 400 });
    }

    try {
      Address.fromString(targetContractId);
    } catch {
      return NextResponse.json(
        { error: "targetContractId must be a valid C-address" },
        { status: 400 }
      );
    }

    if (typeof name === "string" && name.length > CONTEXT_RULE_NAME_MAX_LEN) {
      return NextResponse.json(
        {
          error: `name must be at most ${CONTEXT_RULE_NAME_MAX_LEN} characters`,
        },
        { status: 400 }
      );
    }

    const server = new rpc.Server(config.rpcUrl);
    const { discovery } = await discoverContextRule(
      server,
      config.networkPassphrase,
      smartAccountAddress,
      targetContractId
    );

    if (hasMatchedCallContractRule(discovery)) {
      return NextResponse.json({
        alreadyConfigured: true,
        message: `CallContract(${targetContractId}) rule already exists.`,
        targetContractId,
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
    const ruleName =
      typeof name === "string" && name.trim()
        ? name.trim()
        : defaultRuleName(targetContractId);

    const buildResult = await buildAuthTransaction({
      server,
      networkPassphrase: config.networkPassphrase,
      bundlerKeypair,
      smartAccountAddress,
      targetContractId,
      buildOperationsOnSmartAccount: (smartAccount) => [
        buildAddContextRuleForContractOperation(
          smartAccount,
          targetContractId,
          ruleName,
          signersVec
        ),
      ],
      signerType,
      signerG: gAddress,
      requireMatchedContextRule: false,
    });

    return NextResponse.json({
      ...buildResult,
      targetContractId,
      ruleName,
      instructions:
        "Sign and submit this setup transaction to allow CallContract for the target.",
    });
  } catch (error) {
    console.error("Error building setup-context-rule:", error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Failed to build setup transaction",
      },
      { status: 500 }
    );
  }
}
