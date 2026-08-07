import { NextRequest, NextResponse } from "next/server";
import { rpc } from "@stellar/stellar-sdk";
import { fetchSacBalance } from "@/lib/soroban-balances";
import { isNetwork, resolveNetwork } from "@/lib/network";
import { ApiRequestError } from "@/lib/api-errors";
import {
  discoverDefaultContextRule,
  fetchContextRuleAtId,
} from "@/lib/soroban-context-rules";
import { getBundlerKeypair, canServerSignDelegatedG } from "@/lib/bundler-config";
import { SWAP_ROUTER_CONTRACTS } from "@/lib/swap-routers";
import {
  buildAuthTransaction,
  buildSwapChainedOperation,
  type SignerType,
} from "@/lib/soroban-transaction-build";
import {
  validateContextRuleForSignerType,
  assertSwapRuleReadyForSign,
  resolveSwapAuthMode,
} from "@/lib/transaction/validateContextRuleSigners";

const SIGNER_TYPES = new Set<SignerType>(["passkey", "phantom", "freighter"]);

function resolveRouterContractId(
  network: "testnet" | "mainnet",
  routerContractId?: string
): string {
  const fromBody = routerContractId?.trim();
  if (fromBody) return fromBody;
  return SWAP_ROUTER_CONTRACTS[network];
}

function parseU128(raw: string, fieldName: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw Object.assign(new Error(`${fieldName} must be a non-negative integer string.`), {
      status: 400,
    });
  }
  return BigInt(raw);
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
      signerType,
      signerG,
      routerContractId,
      swapChainXdr,
      tokenInContractId,
      amountInRaw,
      amountOutMinRaw,
      providerId,
    } = body;

    if (!network || !isNetwork(network)) {
      return NextResponse.json(
        { error: 'network must be "testnet" or "mainnet".' },
        { status: 400 }
      );
    }

    if (!smartAccountAddress || typeof smartAccountAddress !== "string") {
      return NextResponse.json({ error: "Missing smartAccountAddress" }, { status: 400 });
    }
    if (!signerType || !SIGNER_TYPES.has(signerType)) {
      return NextResponse.json(
        { error: "signerType must be passkey, phantom, or freighter" },
        { status: 400 }
      );
    }
    if (!swapChainXdr || typeof swapChainXdr !== "string") {
      return NextResponse.json({ error: "Missing swapChainXdr" }, { status: 400 });
    }
    if (!tokenInContractId || typeof tokenInContractId !== "string") {
      return NextResponse.json({ error: "Missing tokenInContractId" }, { status: 400 });
    }
    if (amountInRaw === undefined || amountInRaw === null) {
      return NextResponse.json({ error: "Missing amountInRaw" }, { status: 400 });
    }
    if (amountOutMinRaw === undefined || amountOutMinRaw === null) {
      return NextResponse.json({ error: "Missing amountOutMinRaw" }, { status: 400 });
    }
    if (signerType === "freighter" && (!signerG || typeof signerG !== "string")) {
      return NextResponse.json({ error: "signerG is required for freighter" }, { status: 400 });
    }

    const bundlerKeypair = getBundlerKeypair();
    const bundlerPublicKey = bundlerKeypair.publicKey();

    if (signerType === "freighter" && signerG === bundlerPublicKey) {
      return NextResponse.json(
        {
          error:
            "signerG must be your Freighter G-address, not the bundler fee-payer (PLASMO_PUBLIC_LATCH_FEE_PAYER_G).",
          code: "validation_error",
        },
        { status: 400 }
      );
    }

    const amountIn = parseU128(String(amountInRaw), "amountInRaw");
    const amountOutMin = parseU128(String(amountOutMinRaw), "amountOutMinRaw");

    const { rpcUrl, networkPassphrase } = resolveNetwork(network);
    const routerId = resolveRouterContractId(network, routerContractId);
    const server = new rpc.Server(rpcUrl);

    // Swaps authorize via the Default context rule (rule 0), one id per auth-context node.
    const { contextRuleId } = await discoverDefaultContextRule(
      server,
      networkPassphrase,
      smartAccountAddress
    );

    const swapRule = await fetchContextRuleAtId(
      server,
      networkPassphrase,
      smartAccountAddress,
      contextRuleId
    );

    const swapAuth = resolveSwapAuthMode({
      rule: swapRule,
      signerType,
      signerG,
    });

    if (swapAuth.needsPasskeySetup) {
      assertSwapRuleReadyForSign({ rule: swapRule, contextRuleId });
    }

    if (!swapAuth.useDelegatedAuth) {
      await validateContextRuleForSignerType({
        server,
        networkPassphrase,
        smartAccountAddress,
        contextRuleId,
        signerType,
        signerG,
        feePayerG: bundlerPublicKey,
        bundlerPublicKey,
      });
    }

    const balance = await fetchSacBalance(
      server,
      networkPassphrase,
      tokenInContractId,
      smartAccountAddress
    );
    if (amountIn > balance) {
      return NextResponse.json(
        {
          error: `Insufficient balance: have ${balance.toString()} minimal units, need ${amountIn.toString()}`,
        },
        { status: 400 }
      );
    }

    const delegatedAuthG = swapAuth.delegatedAuthG;

    const buildResult = await buildAuthTransaction({
      server,
      networkPassphrase,
      bundlerKeypair,
      smartAccountAddress,
      targetContractId: routerId,
      buildOperation: buildSwapChainedOperation(
        smartAccountAddress,
        swapChainXdr,
        tokenInContractId,
        amountIn,
        amountOutMin
      ),
      signerType,
      signerG: swapAuth.useDelegatedAuth ? delegatedAuthG : signerG,
      feePayerG: bundlerPublicKey,
      useDefaultContextRule: true,
      bundlerDelegatedAuthMode: swapAuth.useDelegatedAuth,
      delegatedAuthG,
      requireMatchedContextRule: false,
    });

    const submitMethod = swapAuth.useDelegatedAuth
      ? delegatedAuthG && canServerSignDelegatedG(delegatedAuthG)
        ? "bundler-delegated"
        : "delegated"
      : signerType === "freighter"
        ? "delegated"
        : "webauthn";

    return NextResponse.json({
      ...buildResult,
      routerContractId: routerId,
      tokenInContractId,
      amountInRaw: amountIn.toString(),
      amountOutMinRaw: amountOutMin.toString(),
      providerId: providerId ?? "aquarius",
      submitMethod,
      delegatedAuthG: swapAuth.useDelegatedAuth ? delegatedAuthG : buildResult.delegatedAuthG,
    });
  } catch (error) {
    if (error instanceof ApiRequestError) {
      return NextResponse.json(
        {
          error: error.message,
          code: error.code,
          suggestedAction:
            error.code === "NO_CONTEXT_RULE"
              ? "setup_swap_rule"
              : error.code === "SIGNER_MISMATCH"
                ? "reconfigure_swap_rule"
                : undefined,
        },
        { status: error.status }
      );
    }
    const err = error as Error & { code?: string; status?: number };
    if (err.code === "NO_CONTEXT_RULE" || err.code === "SIGNER_MISMATCH") {
      return NextResponse.json(
        {
          error: err.message,
          code: err.code,
          suggestedAction: err.code === "NO_CONTEXT_RULE" ? "setup_swap_rule" : "reconfigure_swap_rule",
        },
        { status: 409 }
      );
    }
    if (err.status === 400) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Error building swap transaction:", error);
    return NextResponse.json(
      { error: err.message ?? "Failed to build swap transaction" },
      { status: 500 }
    );
  }
}
