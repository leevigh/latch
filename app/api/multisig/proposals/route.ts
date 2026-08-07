import { NextRequest, NextResponse } from "next/server";
import { Address, Keypair, Networks, rpc } from "@stellar/stellar-sdk";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";
import { nowMs } from "@/lib/db";
import { buildAuthTransaction, buildSacTransferOperation } from "@/lib/soroban-transaction-build";
import { MULTISIG_AUTH_LEDGER_TTL } from "@/lib/multisig-proposal-artifacts";
import { fetchSacBalance } from "@/lib/soroban-balances";
import { parseRecipientAddress } from "@/lib/soroban-recipient";
import { parseAmountToI128, resolveAsset } from "@/lib/stellar-assets";

export const runtime = "nodejs";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

type SacTransferParams = {
  tokenContractId: string;
  recipient: string;
  amountI128: string;
  assetId?: string;
  symbol?: string;
  amount?: string;
};

type ProposalBody = {
  smartAccountAddress: string;
  operationKind: "counter_increment" | "sac_transfer";
  operationParams?: Record<string, unknown>;
  assetId?: string;
  recipient?: string;
  amount?: string;
  tokenContractId?: string;
  amountI128?: string;
  targetContractId?: string;
  requireMatchedContextRule?: boolean;
};

function resolveSacTransferParams(
  body: ProposalBody,
  networkPassphrase: string
): SacTransferParams {
  if (body.assetId && body.recipient != null && body.amount != null) {
    const asset = resolveAsset(networkPassphrase, body.assetId);
    parseRecipientAddress(body.recipient);
    const recipient = body.recipient.trim();
    const amountI128 = parseAmountToI128(String(body.amount), asset.decimals);
    return {
      tokenContractId: asset.contractId,
      recipient,
      amountI128: amountI128.toString(),
      assetId: asset.assetId,
      symbol: asset.symbol,
      amount: String(body.amount).trim(),
    };
  }

  const tokenContractId = body.tokenContractId ?? body.targetContractId;
  const recipient = String(body.recipient ?? "");
  const amountI128 = BigInt(String(body.amountI128 ?? "0"));
  if (!tokenContractId || !recipient || amountI128 <= 0n) {
    throw new Error(
      "sac_transfer requires assetId/recipient/amount or tokenContractId/recipient/amountI128"
    );
  }
  parseRecipientAddress(recipient);

  let assetId: string | undefined;
  let symbol: string | undefined;
  try {
    const asset = resolveAsset(networkPassphrase, undefined, tokenContractId);
    assetId = asset.assetId;
    symbol = asset.symbol;
  } catch {
    /* allowlist miss — still store raw contract id */
  }

  return {
    tokenContractId,
    recipient: recipient.trim(),
    amountI128: amountI128.toString(),
    assetId,
    symbol,
  };
}

export async function GET(request: NextRequest) {
  try {
    const { userId } = await getOrCreateSession();
    const { searchParams } = new URL(request.url);
    const smartAccountAddress = searchParams.get("account");
    if (!smartAccountAddress) {
      return NextResponse.json({ error: "Missing account query param" }, { status: 400 });
    }

    const acct = await prisma.multisigAccount.findUnique({
      where: { smartAccountAddress },
      select: { id: true, userId: true, smartAccountAddress: true, threshold: true },
    });
    if (!acct || acct.userId !== userId) {
      return NextResponse.json({ error: "Unknown multisig account" }, { status: 404 });
    }

    const proposals = await prisma.multisigProposal.findMany({
      where: { multisigAccountId: acct.id },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        status: true,
        operationKind: true,
        operationParamsJson: true,
        authDigestHex: true,
        validUntilLedger: true,
        createdAt: true,
        executedTxHash: true,
        _count: { select: { approvals: true } },
      },
    });

    return NextResponse.json({
      threshold: acct.threshold,
      proposals: proposals.map((p) => ({
        id: p.id,
        status: p.status,
        operationKind: p.operationKind,
        operationParams: JSON.parse(p.operationParamsJson),
        authDigestHex: p.authDigestHex,
        validUntilLedger: p.validUntilLedger,
        createdAt: Number(p.createdAt),
        executedTxHash: p.executedTxHash ?? null,
        approvalCount: p._count.approvals,
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "List proposals failed" },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const config = getConfig();
  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const { userId } = await getOrCreateSession();
    const body = (await request.json()) as ProposalBody;
    const now = nowMs();

    if (!body?.smartAccountAddress || typeof body.smartAccountAddress !== "string") {
      return NextResponse.json({ error: "Missing smartAccountAddress" }, { status: 400 });
    }
    if (!body?.operationKind) {
      return NextResponse.json({ error: "Missing operationKind" }, { status: 400 });
    }

    const acct = await prisma.multisigAccount.findUnique({
      where: { smartAccountAddress: body.smartAccountAddress },
      select: { id: true, userId: true, smartAccountAddress: true },
    });
    if (!acct || acct.userId !== userId) {
      return NextResponse.json({ error: "Unknown multisig account" }, { status: 404 });
    }

    const server = new rpc.Server(config.rpcUrl);
    const bundlerKeypair = Keypair.fromSecret(config.bundlerSecret);

    let targetContractId = body.targetContractId;
    let operationParams: Record<string, unknown> = body.operationParams ?? {};

    const buildOperation = (() => {
      if (body.operationKind === "counter_increment") {
        if (!targetContractId || typeof targetContractId !== "string") {
          throw new Error("Missing targetContractId for counter_increment");
        }
        operationParams = {};
        return (contract: { call: (method: string, ...args: unknown[]) => unknown }) =>
          contract.call("increment", new Address(body.smartAccountAddress).toScVal());
      }
      if (body.operationKind === "sac_transfer") {
        const transfer = resolveSacTransferParams(body, config.networkPassphrase);
        targetContractId = transfer.tokenContractId;
        operationParams = transfer;
        const amountI128 = BigInt(transfer.amountI128);
        return buildSacTransferOperation(
          transfer.tokenContractId,
          body.smartAccountAddress,
          transfer.recipient,
          amountI128
        );
      }
      throw new Error(`Unsupported operationKind: ${body.operationKind}`);
    })();

    if (!targetContractId || typeof targetContractId !== "string") {
      return NextResponse.json({ error: "Missing targetContractId" }, { status: 400 });
    }

    if (body.operationKind === "sac_transfer") {
      const transfer = operationParams as SacTransferParams;
      const balance = await fetchSacBalance(
        server,
        config.networkPassphrase,
        transfer.tokenContractId,
        body.smartAccountAddress
      );
      const amountI128 = BigInt(transfer.amountI128);
      if (amountI128 > balance) {
        return NextResponse.json(
          {
            error: `Insufficient balance: have ${balance.toString()} minimal units, need ${amountI128.toString()}`,
          },
          { status: 400 }
        );
      }
    }

    let buildResult;
    try {
      buildResult = await buildAuthTransaction({
        server,
        networkPassphrase: config.networkPassphrase,
        bundlerKeypair,
        smartAccountAddress: body.smartAccountAddress,
        targetContractId,
        buildOperation: buildOperation as NonNullable<
          Parameters<typeof buildAuthTransaction>[0]["buildOperation"]
        >,
        signerType: "passkey",
        signerG: null,
        requireMatchedContextRule: body.requireMatchedContextRule === true,
        authEntryLedgerTtl: MULTISIG_AUTH_LEDGER_TTL,
      });
    } catch (e) {
      const err = e as Error & { code?: string };
      if (err.code === "NO_CONTEXT_RULE") {
        return NextResponse.json(
          {
            error: err.message,
            code: "NO_CONTEXT_RULE",
            suggestedAction: "multisig_context_rule_setup",
          },
          { status: 409 }
        );
      }
      throw e;
    }

    const proposal = await prisma.multisigProposal.create({
      data: {
        multisigAccountId: acct.id,
        createdByUserId: userId,
        targetContractId,
        operationKind: body.operationKind,
        operationParamsJson: JSON.stringify(operationParams),
        txXdr: buildResult.txXdr,
        authEntriesXdrJson: JSON.stringify(buildResult.authEntriesXdr),
        smartAccountAuthEntryIndex: buildResult.smartAccountAuthEntryIndex,
        contextRuleId: buildResult.contextRuleId,
        authDigestHex: buildResult.authDigestHex,
        signaturePayloadHex: buildResult.signaturePayloadHex,
        validUntilLedger: buildResult.validUntilLedger,
        status: "pending",
        createdAt: BigInt(now),
      },
      select: {
        id: true,
        authDigestHex: true,
        validUntilLedger: true,
        contextRuleId: true,
        signaturePayloadHex: true,
      },
    });

    return NextResponse.json({
      proposal: {
        id: proposal.id,
        authDigestHex: proposal.authDigestHex,
        validUntilLedger: proposal.validUntilLedger,
        contextRuleId: proposal.contextRuleId,
        signaturePayloadHex: proposal.signaturePayloadHex,
      },
    });
  } catch (error) {
    const err = error as Error & { code?: string };
    const status = err.code === "NO_CONTEXT_RULE" ? 409 : 400;
    return NextResponse.json(
      { error: err.message ?? "Create proposal failed", code: err.code },
      { status }
    );
  }
}
