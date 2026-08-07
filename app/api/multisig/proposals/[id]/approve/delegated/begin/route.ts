import { NextRequest, NextResponse } from "next/server";
import { Networks, rpc, xdr } from "@stellar/stellar-sdk";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";
import { nowMs } from "@/lib/db";
import { buildDelegatedCheckAuthTemplate } from "@/lib/delegated-check-auth-entry";
import {
  ProposalRefreshRequiredError,
  PROPOSAL_REFRESHED_CODE,
  ensureMultisigProposalFresh,
} from "@/lib/multisig-proposal-artifacts";

export const runtime = "nodejs";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
});

type Body = {
  memberId: string;
};

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const config = getConfig();
    const { userId } = await getOrCreateSession();
    const { id: proposalId } = await props.params;
    const body = (await request.json()) as Body;
    const now = nowMs();

    if (!body?.memberId || typeof body.memberId !== "string") {
      return NextResponse.json({ error: "Missing memberId" }, { status: 400 });
    }

    const proposal = await prisma.multisigProposal.findUnique({
      where: { id: proposalId },
      select: {
        id: true,
        multisigAccountId: true,
        authEntriesXdrJson: true,
        smartAccountAuthEntryIndex: true,
        contextRuleId: true,
        validUntilLedger: true,
        status: true,
      },
    });
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    if (proposal.status !== "pending") {
      return NextResponse.json({ error: `Proposal not pending (status=${proposal.status})` }, { status: 409 });
    }

    const acct = await prisma.multisigAccount.findUnique({
      where: { id: proposal.multisigAccountId },
      select: { id: true, userId: true, smartAccountAddress: true },
    });
    if (!acct || acct.userId !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const server = new rpc.Server(config.rpcUrl);
    try {
      await ensureMultisigProposalFresh({
        proposalId,
        server,
        networkPassphrase: config.networkPassphrase,
        bundlerSecret: process.env.BUNDLER_SECRET!,
      });
    } catch (e) {
      if (e instanceof ProposalRefreshRequiredError) {
        return NextResponse.json(
          { error: e.message, code: PROPOSAL_REFRESHED_CODE, refreshed: true },
          { status: 409 }
        );
      }
      throw e;
    }

    const proposalFresh = await prisma.multisigProposal.findUnique({
      where: { id: proposalId },
      select: {
        id: true,
        authEntriesXdrJson: true,
        smartAccountAuthEntryIndex: true,
        contextRuleId: true,
        validUntilLedger: true,
        status: true,
      },
    });
    if (!proposalFresh || proposalFresh.status !== "pending") {
      return NextResponse.json({ error: "Proposal not pending" }, { status: 409 });
    }

    const member = await prisma.multisigMember.findUnique({
      where: { id: body.memberId },
      select: { id: true, multisigAccountId: true, memberType: true, gAddress: true },
    });
    if (!member || member.multisigAccountId !== acct.id) {
      return NextResponse.json({ error: "Member not found for this account" }, { status: 404 });
    }
    if (member.memberType !== "delegated" || !member.gAddress) {
      return NextResponse.json({ error: "Member is not delegated type" }, { status: 400 });
    }

    const authEntriesXdr: string[] = JSON.parse(proposalFresh.authEntriesXdrJson);
    const entries = authEntriesXdr.map((b64) =>
      xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64")
    );
    const smartIndex = proposalFresh.smartAccountAuthEntryIndex;
    if (smartIndex < 0 || smartIndex >= entries.length) {
      return NextResponse.json({ error: "Invalid smart account auth entry index" }, { status: 500 });
    }

    const { preimageXdrBase64, entryTemplateXdrBase64, authDigestHex } =
      buildDelegatedCheckAuthTemplate({
        networkPassphrase: config.networkPassphrase,
        smartAccountAddress: acct.smartAccountAddress,
        signerG: member.gAddress,
        smartAccountAuthEntry: entries[smartIndex],
        contextRuleIds: [proposalFresh.contextRuleId],
        validUntilLedger: proposalFresh.validUntilLedger,
      });

    await prisma.multisigApproval.upsert({
      where: { proposalId_memberId: { proposalId, memberId: member.id } },
      create: {
        proposalId,
        memberId: member.id,
        approvalType: "delegated",
        delegatedEntryTemplateXdr: entryTemplateXdrBase64,
        delegatedSignerAddress: member.gAddress,
        createdAt: BigInt(now),
      },
      update: {
        approvalType: "delegated",
        delegatedEntryTemplateXdr: entryTemplateXdrBase64,
        delegatedSignerAddress: member.gAddress,
        delegatedSignedAuthEntryBase64: null,
      },
    });

    return NextResponse.json({
      signerAddress: member.gAddress,
      gAddressPreimageXdr: preimageXdrBase64,
      gAddressEntryTemplateXdr: entryTemplateXdrBase64,
      authDigestHex,
      validUntilLedger: proposalFresh.validUntilLedger,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Begin delegated approval failed" },
      { status: 500 }
    );
  }
}
