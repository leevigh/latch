import { NextRequest, NextResponse } from "next/server";
import { Keypair, rpc } from "@stellar/stellar-sdk";
import { apiError } from "@/lib/api-errors";
import { ApiRequestError } from "@/lib/api-errors";
import { isNetwork, NetworkConfigError, resolveNetwork } from "@/lib/network";
import { fetchSacBalance } from "@/lib/soroban-balances";
import { parseRecipientAddress } from "@/lib/soroban-recipient";
import {
  discoverContextRule,
  hasMatchedCallContractRule,
} from "@/lib/soroban-context-rules";
import {
  buildSacTransferOperation,
  buildUnsignedSorobanTransaction,
} from "@/lib/soroban-transaction-build";
import { parseAmountToI128, resolveAsset } from "@/lib/stellar-assets";
import { truncateAddress } from "@/lib/transaction/parseOperationsForReview";

export const runtime = "nodejs";

const DEMO_ACTIONS = new Set(["noop", "transfer"]);

/** Minimal native transfer for noop smoke test — must require smart-account auth. */
const NOOP_SELF_TRANSFER_AMOUNT = "0.0000001";
const NOOP_ASSET_ID = "native";

export async function POST(request: NextRequest) {
  if (process.env.NODE_ENV === "production") {
    return apiError({
      status: 403,
      code: "forbidden",
      message: "build-sign-demo is not available in production.",
    });
  }

  try {
    const body = await request.json();
    const { network, smartAccountAddress, demoAction, recipient, amount, assetId, contractId } =
      body;

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

    if (!demoAction || !DEMO_ACTIONS.has(demoAction)) {
      return apiError({
        status: 400,
        code: "validation_error",
        message: 'demoAction must be "noop" or "transfer".',
      });
    }

    const bundlerSecret = process.env.BUNDLER_SECRET;
    if (!bundlerSecret) {
      return apiError({
        status: 500,
        code: "internal_error",
        message: "BUNDLER_SECRET is not set.",
      });
    }

    const { rpcUrl, networkPassphrase } = resolveNetwork(network);
    const server = new rpc.Server(rpcUrl);
    const bundlerKeypair = Keypair.fromSecret(bundlerSecret);

    let description: string;
    let unsignedTxXdr: string;

    if (demoAction === "noop") {
      const asset = resolveAsset(networkPassphrase, NOOP_ASSET_ID);
      const amountI128 = parseAmountToI128(NOOP_SELF_TRANSFER_AMOUNT, asset.decimals);

      const balance = await fetchSacBalance(
        server,
        networkPassphrase,
        asset.contractId,
        smartAccountAddress
      );
      if (amountI128 > balance) {
        return apiError({
          status: 400,
          code: "validation_error",
          message: `Insufficient balance for noop smoke test (need ${NOOP_SELF_TRANSFER_AMOUNT} ${asset.symbol}).`,
        });
      }

      // Same gate as transfer so the demo client can auto-run setup-send-rules then retry.
      const { discovery } = await discoverContextRule(
        server,
        networkPassphrase,
        smartAccountAddress,
        asset.contractId
      );
      if (!hasMatchedCallContractRule(discovery)) {
        return apiError({
          status: 409,
          code: "NO_CONTEXT_RULE",
          message: `No context rule allows CallContract(${asset.contractId}). Run setup-send-rules first.`,
          suggestedAction: "setup_transfer_rule",
        });
      }

      const tx = await buildUnsignedSorobanTransaction({
        server,
        networkPassphrase,
        bundlerKeypair,
        smartAccountAddress,
        targetContractId: asset.contractId,
        buildOperation: buildSacTransferOperation(
          asset.contractId,
          smartAccountAddress,
          smartAccountAddress,
          amountI128
        ),
      });
      unsignedTxXdr = tx.toXDR();
      description = `Transfer ${NOOP_SELF_TRANSFER_AMOUNT} ${asset.symbol} to self (smoke test)`;
    } else {
      if (!recipient || typeof recipient !== "string") {
        return apiError({
          status: 400,
          code: "validation_error",
          message: "recipient is required for transfer demo.",
        });
      }
      if (amount === undefined || amount === null) {
        return apiError({
          status: 400,
          code: "validation_error",
          message: "amount is required for transfer demo.",
        });
      }

      const asset = resolveAsset(networkPassphrase, assetId, contractId);
      const amountI128 = parseAmountToI128(String(amount), asset.decimals);
      parseRecipientAddress(recipient);

      const balance = await fetchSacBalance(
        server,
        networkPassphrase,
        asset.contractId,
        smartAccountAddress
      );
      if (amountI128 > balance) {
        return apiError({
          status: 400,
          code: "validation_error",
          message: `Insufficient balance for demo transfer.`,
        });
      }

      const { discovery } = await discoverContextRule(
        server,
        networkPassphrase,
        smartAccountAddress,
        asset.contractId
      );
      if (!hasMatchedCallContractRule(discovery)) {
        return apiError({
          status: 409,
          code: "NO_CONTEXT_RULE",
          message: `No context rule allows CallContract(${asset.contractId}). Run setup-send-rules first.`,
          suggestedAction: "setup_transfer_rule",
        });
      }

      const tx = await buildUnsignedSorobanTransaction({
        server,
        networkPassphrase,
        bundlerKeypair,
        smartAccountAddress,
        targetContractId: asset.contractId,
        buildOperation: buildSacTransferOperation(
          asset.contractId,
          smartAccountAddress,
          recipient.trim(),
          amountI128
        ),
      });
      unsignedTxXdr = tx.toXDR();

      description = `Transfer ${amount} ${asset.symbol} to ${truncateAddress(recipient.trim())}`;
    }

    return NextResponse.json({
      unsignedTxXdr,
      description,
      network,
      smartAccountAddress,
    });
  } catch (error) {
    if (error instanceof NetworkConfigError) {
      return apiError({ status: 400, code: error.code, message: error.message });
    }
    const err = error as Error & { code?: string };
    if (err.code === "NO_CONTEXT_RULE") {
      return apiError({
        status: 409,
        code: "NO_CONTEXT_RULE",
        message: err.message,
        suggestedAction: "setup_transfer_rule",
      });
    }
    if (error instanceof ApiRequestError) {
      return apiError({
        status: error.status,
        code: error.code,
        message: error.message,
      });
    }
    console.error("build-sign-demo error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return apiError({ status: 500, code: "internal_error", message });
  }
}
