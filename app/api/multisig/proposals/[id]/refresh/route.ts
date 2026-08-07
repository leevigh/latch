import { NextRequest, NextResponse } from "next/server";
import { Networks, rpc } from "@stellar/stellar-sdk";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";
import { rebuildMultisigProposalArtifacts } from "@/lib/multisig-proposal-artifacts";

export const runtime = "nodejs";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  bundlerSecret: process.env.BUNDLER_SECRET,
});

export async function POST(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  const config = getConfig();
  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }

  try {
    const { userId } = await getOrCreateSession();
    const { id: proposalId } = await props.params;
    const server = new rpc.Server(config.rpcUrl);

    const proposal = await prisma.multisigProposal.findUnique({
      where: { id: proposalId },
      select: { id: true, multisigAccountId: true, status: true },
    });
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    if (proposal.status !== "pending") {
      return NextResponse.json({ error: "Proposal not pending" }, { status: 409 });
    }

    const acct = await prisma.multisigAccount.findUnique({
      where: { id: proposal.multisigAccountId },
      select: { userId: true },
    });
    if (!acct || acct.userId !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const buildResult = await rebuildMultisigProposalArtifacts({
      proposalId,
      server,
      networkPassphrase: config.networkPassphrase,
      bundlerSecret: config.bundlerSecret,
    });

    return NextResponse.json({
      refreshed: true,
      validUntilLedger: buildResult.validUntilLedger,
      authDigestHex: buildResult.authDigestHex,
      message: "Approvals were cleared. All signers must approve again.",
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Refresh failed" },
      { status: 500 }
    );
  }
}
