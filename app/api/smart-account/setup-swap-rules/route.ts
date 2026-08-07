import { NextRequest, NextResponse } from "next/server";
import { rpc } from "@stellar/stellar-sdk";
import {
  discoverDefaultContextRule,
  fetchContextRuleAtId,
  ruleHasDelegatedSigner,
  ruleHasExternalPasskey,
  ruleHasExternalSigner,
} from "@/lib/soroban-context-rules";
import {
  buildAddSignerOperation,
  buildDelegatedSignerScVal,
  buildExternalSignerScVal,
} from "@/lib/soroban-setup-signers";
import { getBundlerKeypair, delegatedGFromContextRule } from "@/lib/bundler-config";
import {
  buildAuthTransaction,
  type SignerType,
} from "@/lib/soroban-transaction-build";
import { SWAP_ROUTER_CONTRACTS } from "@/lib/swap-routers";
import { isNetwork, resolveNetwork } from "@/lib/network";
import { contextRuleSignersMatchSetup } from "@/lib/transaction/validateContextRuleSigners";
import {
  normalizeSetupSignerType,
  parseSetupRequestKeyDataHex,
  resolvePasskeyKeyDataHex,
} from "@/lib/transaction/resolvePasskeyKeyData";

function resolveRouterContractId(
  network: "testnet" | "mainnet",
  routerContractId?: string
): string {
  const fromBody = routerContractId?.trim();
  if (fromBody) return fromBody;
  return SWAP_ROUTER_CONTRACTS[network];
}

function validateFreighterSetup(gAddress: string | undefined, bundlerPublicKey: string): string {
  if (!gAddress?.trim()) {
    throw Object.assign(new Error("gAddress is required for Freighter setup."), {
      code: "validation_error",
      status: 400,
    });
  }
  const g = gAddress.trim();
  if (g === bundlerPublicKey) {
    throw Object.assign(
      new Error("gAddress must be your Freighter G-address, not the bundler fee-payer."),
      { code: "validation_error", status: 400 }
    );
  }
  return g;
}

export async function POST(request: NextRequest) {
  const bundlerSecret = process.env.BUNDLER_SECRET;

  if (!bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const body = await request.json();
    const {
      network,
      smartAccountAddress,
      providerId,
      routerContractId,
      publicKeyHex,
      gAddress,
    } = body;

    const signerType: SignerType =
      normalizeSetupSignerType(body.signerType) ?? "passkey";

    if (!network || !isNetwork(network)) {
      return NextResponse.json(
        { error: 'network must be "testnet" or "mainnet".' },
        { status: 400 }
      );
    }

    if (!smartAccountAddress || typeof smartAccountAddress !== "string") {
      return NextResponse.json({ error: "Missing smartAccountAddress" }, { status: 400 });
    }

    const bundlerKeypair = getBundlerKeypair();
    const bundlerPublicKey = bundlerKeypair.publicKey();

    const keyDataHexFromRequest = parseSetupRequestKeyDataHex(body);
    const credentialId =
      typeof body.credentialId === "string"
        ? body.credentialId
        : typeof body.credential_id === "string"
          ? body.credential_id
          : undefined;

    const webauthnVerifier = process.env.NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS;

    const { rpcUrl, networkPassphrase } = resolveNetwork(network);
    const server = new rpc.Server(rpcUrl);

    const keyDataHex =
      signerType === "passkey"
        ? await resolvePasskeyKeyDataHex({
            smartAccountAddress,
            keyDataHexFromRequest,
            credentialId,
            server,
            networkPassphrase,
            webauthnVerifier,
          })
        : keyDataHexFromRequest;

    if (signerType === "passkey" && !keyDataHex) {
      return NextResponse.json(
        {
          error:
            "Could not resolve your passkey for this smart account. " +
            "The extension should pass keyDataHex (your WebAuthn credential bytes from login), " +
            "or the account must be registered in Latch so the API can look it up.",
          code: "missing_key_data",
          hint: "keyDataHex is the hex encoding of your passkey public key + credential id — the same value used for submit-webauthn.",
        },
        { status: 400 }
      );
    }

    if (signerType === "phantom" && !publicKeyHex) {
      return NextResponse.json(
        { error: "publicKeyHex is required for phantom setup.", code: "validation_error" },
        { status: 400 }
      );
    }

    const freighterG =
      signerType === "freighter" ? validateFreighterSetup(gAddress, bundlerPublicKey) : undefined;

    const routerId = resolveRouterContractId(network, routerContractId);

    const { contextRuleId } = await discoverDefaultContextRule(
      server,
      networkPassphrase,
      smartAccountAddress
    );

    const defaultRule = await fetchContextRuleAtId(
      server,
      networkPassphrase,
      smartAccountAddress,
      contextRuleId
    );

    const verifierAddress =
      signerType === "passkey"
        ? process.env.NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS
        : process.env.NEXT_PUBLIC_VERIFIER_ADDRESS;

    if (
      defaultRule &&
      signerType === "freighter" &&
      freighterG &&
      ruleHasDelegatedSigner(defaultRule, freighterG)
    ) {
      return NextResponse.json({
        alreadyConfigured: true,
        message:
          `Default context rule already authorizes Delegated(${freighterG}). ` +
          `No setup needed — swaps use this delegated signer.`,
        routerContractId: routerId,
        contextRuleId,
      });
    }

    if (
      defaultRule &&
      signerType === "passkey" &&
      webauthnVerifier &&
      ruleHasExternalPasskey(defaultRule, webauthnVerifier)
    ) {
      return NextResponse.json({
        alreadyConfigured: true,
        message: "Default context rule already has your passkey signer for swaps.",
        routerContractId: routerId,
        contextRuleId,
      });
    }

    if (
      defaultRule &&
      contextRuleSignersMatchSetup({
        rule: defaultRule,
        signerType,
        verifierAddress: verifierAddress ?? undefined,
        gAddress: freighterG,
      }) &&
      ruleHasExternalSigner(defaultRule)
    ) {
      return NextResponse.json({
        alreadyConfigured: true,
        message: "Default context rule already has your passkey signer for swaps.",
        routerContractId: routerId,
        contextRuleId,
      });
    }

    if (!verifierAddress && signerType !== "freighter") {
      return NextResponse.json(
        {
          error:
            signerType === "passkey"
              ? "NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS is not configured on the server."
              : "Verifier address not configured for this signer type.",
        },
        { status: 500 }
      );
    }

    const signerScVal =
      signerType === "passkey" && verifierAddress && keyDataHex
        ? buildExternalSignerScVal(verifierAddress, Buffer.from(keyDataHex, "hex"))
        : signerType === "phantom" && verifierAddress && publicKeyHex
          ? buildExternalSignerScVal(
              verifierAddress,
              Buffer.from(publicKeyHex, "hex")
            )
          : signerType === "freighter" && freighterG
            ? buildDelegatedSignerScVal(freighterG)
            : null;

    if (!signerScVal) {
      return NextResponse.json(
        {
          error: `Unsupported signer configuration for ${signerType} setup.`,
          code: "validation_error",
        },
        { status: 400 }
      );
    }

    const buildResult = await buildAuthTransaction({
      server,
      networkPassphrase,
      bundlerKeypair,
      smartAccountAddress,
      targetContractId: routerId,
      buildOperationsOnSmartAccount: (smartAccount) => [
        buildAddSignerOperation(smartAccount, contextRuleId, signerScVal),
      ],
      signerType,
      signerG: freighterG,
      feePayerG: bundlerPublicKey,
      requireMatchedContextRule: false,
    });

    const staleDelegatedG = defaultRule ? delegatedGFromContextRule(defaultRule) : null;

    return NextResponse.json({
      ...buildResult,
      routerContractId: routerId,
      providerId: providerId ?? "aquarius",
      contextRuleId,
      keyDataHexResolved: signerType === "passkey" ? Boolean(keyDataHex) : undefined,
      addedExternalSigner: signerType === "passkey" || signerType === "phantom",
      staleDelegatedSigner: staleDelegatedG ?? undefined,
      delegatedSignerG: buildResult.delegatedAuthG,
      signerAddress: buildResult.delegatedAuthG,
      remainingSetupCount: 0,
      instructions:
        buildResult.submitMethod === "delegated" && buildResult.delegatedAuthG
          ? `Sign the delegated auth entry with ${buildResult.delegatedAuthG}, then submit via submit-delegated. This adds your passkey to the default rule for swaps.`
          : signerType === "passkey" || signerType === "phantom"
            ? "Sign and submit this transaction with your passkey to enable swaps."
            : "Sign and submit this transaction to add your Freighter signer to the default context rule.",
    });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      if (error.code === "simulation_failed" && error.message.includes("#3007")) {
        return NextResponse.json(
          {
            error:
              "This signer is already on the default context rule. " +
              "If you use a passkey account, log out and sign in again so setup can add your passkey. " +
              "If you use Freighter with GCEB7…, swaps should work without setup.",
            code: "signer_already_exists",
          },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status }
      );
    }
    const err = error as Error & { code?: string; status?: number };
    if (err.code === "validation_error" || err.status === 400) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: 400 });
    }
    console.error("Error building setup-swap-rules:", error);
    return NextResponse.json(
      { error: err.message ?? "Failed to build swap setup transaction" },
      { status: 500 }
    );
  }
}
