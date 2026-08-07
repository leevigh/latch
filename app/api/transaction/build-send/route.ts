import { NextRequest, NextResponse } from "next/server";
import { Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { fetchSacBalance } from "@/lib/soroban-balances";
import { parseRecipientAddress } from "@/lib/soroban-recipient";
import {
  buildAuthTransaction,
  buildSacTransferOperation,
  type SignerType,
} from "@/lib/soroban-transaction-build";
import { parseAmountToI128, resolveAsset } from "@/lib/stellar-assets";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase:
    process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  bundlerSecret: process.env.BUNDLER_SECRET,
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
      contractId,
      recipient,
      amount,
      signerG,
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
    if (!recipient || typeof recipient !== "string") {
      return NextResponse.json({ error: "Missing recipient" }, { status: 400 });
    }
    if (amount === undefined || amount === null) {
      return NextResponse.json({ error: "Missing amount" }, { status: 400 });
    }
    if (signerType === "freighter" && (!signerG || typeof signerG !== "string")) {
      return NextResponse.json({ error: "signerG is required for freighter" }, { status: 400 });
    }

    const asset = resolveAsset(config.networkPassphrase, assetId, contractId);
    const amountI128 = parseAmountToI128(String(amount), asset.decimals);
    parseRecipientAddress(recipient);

    const server = new rpc.Server(config.rpcUrl);
    const balance = await fetchSacBalance(
      server,
      config.networkPassphrase,
      asset.contractId,
      smartAccountAddress
    );
    if (amountI128 > balance) {
      return NextResponse.json(
        {
          error: `Insufficient balance: have ${balance.toString()} minimal units, need ${amountI128.toString()}`,
        },
        { status: 400 }
      );
    }

    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);

    const buildResult = await buildAuthTransaction({
      server,
      networkPassphrase: config.networkPassphrase,
      bundlerKeypair,
      smartAccountAddress,
      targetContractId: asset.contractId,
      buildOperation: buildSacTransferOperation(
        asset.contractId,
        smartAccountAddress,
        recipient.trim(),
        amountI128
      ),
      signerType,
      signerG,
      requireMatchedContextRule: true,
    });

    return NextResponse.json({
      ...buildResult,
      asset: {
        assetId: asset.assetId,
        symbol: asset.symbol,
        contractId: asset.contractId,
        decimals: asset.decimals,
      },
      recipient: recipient.trim(),
      amount: String(amount),
      amountRaw: amountI128.toString(),
    });
  } catch (error) {
    const err = error as Error & { code?: string };
    if (err.code === "NO_CONTEXT_RULE") {
      return NextResponse.json(
        {
          error: err.message,
          code: "NO_CONTEXT_RULE",
          suggestedAction: "setup_transfer_rule",
        },
        { status: 409 }
      );
    }
    console.error("Error building send transaction:", error);
    return NextResponse.json(
      { error: err.message ?? "Failed to build send transaction" },
      { status: 500 }
    );
  }
}
