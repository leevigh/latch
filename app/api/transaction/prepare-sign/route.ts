import { NextRequest, NextResponse } from "next/server";
import { apiError } from "@/lib/api-errors";
import { ApiRequestError } from "@/lib/api-errors";
import { isNetwork, NetworkConfigError, resolveNetwork } from "@/lib/network";
import { prepareExternalSign } from "@/lib/transaction/prepareExternalSign";
import type { SignerType } from "@/lib/soroban-transaction-build";

export const maxDuration = 60;
export const runtime = "nodejs";

const SIGNER_TYPES = new Set<SignerType>(["passkey", "phantom", "freighter"]);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const {
      network,
      smartAccountAddress,
      unsignedTxXdr,
      signerType,
      signerG,
      feePayerG,
      contextRuleId,
      contextRuleDiscovery,
    } = body;

    if (!network || !isNetwork(network)) {
      return apiError({
        status: 400,
        code: "invalid_network",
        message: 'network must be "testnet" or "mainnet".',
      });
    }

    if (!smartAccountAddress || typeof smartAccountAddress !== "string") {
      return apiError({
        status: 400,
        code: "validation_error",
        message: "Missing smartAccountAddress.",
      });
    }

    if (!unsignedTxXdr || typeof unsignedTxXdr !== "string") {
      return apiError({
        status: 400,
        code: "validation_error",
        message: "Missing unsignedTxXdr.",
      });
    }

    if (signerType !== undefined && !SIGNER_TYPES.has(signerType)) {
      return apiError({
        status: 400,
        code: "validation_error",
        message: "signerType must be passkey, phantom, or freighter.",
      });
    }

    if (signerType === "freighter" && (!signerG || typeof signerG !== "string")) {
      return apiError({
        status: 400,
        code: "validation_error",
        message: "signerG is required when signerType is freighter.",
      });
    }

    if (!process.env.BUNDLER_SECRET) {
      return apiError({
        status: 500,
        code: "internal_error",
        message: "BUNDLER_SECRET is not set.",
      });
    }

    // Validate network config early
    resolveNetwork(network);

    const result = await prepareExternalSign({
      network,
      smartAccountAddress,
      unsignedTxXdr,
      signerType,
      signerG,
      feePayerG,
      contextRuleId:
        contextRuleId !== undefined && contextRuleId !== null
          ? Number(contextRuleId)
          : undefined,
      contextRuleDiscovery,
    });

    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof NetworkConfigError) {
      return apiError({ status: 400, code: error.code, message: error.message });
    }
    if (error instanceof ApiRequestError) {
      return apiError({
        status: error.status,
        code: error.code,
        message: error.message,
        ...(error.code === "NO_CONTEXT_RULE"
          ? { suggestedAction: "setup_transfer_rule" }
          : {}),
      });
    }
    console.error("prepare-sign error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return apiError({ status: 500, code: "internal_error", message });
  }
}
