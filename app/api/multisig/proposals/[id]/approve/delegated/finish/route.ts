import { NextRequest, NextResponse } from "next/server";
import { Networks } from "@stellar/stellar-sdk";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";
import { verifyDelegatedFreighterSignature } from "@/lib/delegated-check-auth-entry";

export const runtime = "nodejs";

const getConfig = () => ({
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
});

type Body = {
  memberId: string;
  signedAuthEntryBase64: string;
  signerAddress: string;
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

    if (!body?.memberId || typeof body.memberId !== "string") {
      return NextResponse.json({ error: "Missing memberId" }, { status: 400 });
    }
    if (!body?.signedAuthEntryBase64 || typeof body.signedAuthEntryBase64 !== "string") {
      return NextResponse.json({ error: "Missing signedAuthEntryBase64" }, { status: 400 });
    }
    if (!body?.signerAddress || typeof body.signerAddress !== "string") {
      return NextResponse.json({ error: "Missing signerAddress" }, { status: 400 });
    }

    const proposal = await prisma.multisigProposal.findUnique({
      where: { id: proposalId },
      select: { id: true, multisigAccountId: true, status: true },
    });
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    if (proposal.status !== "pending") {
      return NextResponse.json({ error: `Proposal not pending (status=${proposal.status})` }, { status: 409 });
    }

    const acct = await prisma.multisigAccount.findUnique({
      where: { id: proposal.multisigAccountId },
      select: { id: true, userId: true },
    });
    if (!acct || acct.userId !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const member = await prisma.multisigMember.findUnique({
      where: { id: body.memberId },
      select: { id: true, multisigAccountId: true, memberType: true, gAddress: true },
    });
    if (!member || member.multisigAccountId !== acct.id) {
      return NextResponse.json({ error: "Member not found for this account" }, { status: 404 });
    }
    if (member.memberType !== "delegated") {
      return NextResponse.json({ error: "Member is not delegated type" }, { status: 400 });
    }

    const existing = await prisma.multisigApproval.findUnique({
      where: { proposalId_memberId: { proposalId, memberId: member.id } },
      select: { delegatedEntryTemplateXdr: true },
    });
    if (!existing?.delegatedEntryTemplateXdr) {
      return NextResponse.json(
        { error: "Delegated approval not started. Call delegated/begin first." },
        { status: 409 }
      );
    }

    verifyDelegatedFreighterSignature({
      entryTemplateXdrBase64: existing.delegatedEntryTemplateXdr,
      signedAuthEntryBase64: body.signedAuthEntryBase64,
      signerAddress: body.signerAddress,
      networkPassphrase: config.networkPassphrase,
    });

    const approval = await prisma.multisigApproval.update({
      where: { proposalId_memberId: { proposalId, memberId: member.id } },
      data: {
        approvalType: "delegated",
        delegatedSignedAuthEntryBase64: body.signedAuthEntryBase64,
        delegatedSignerAddress: body.signerAddress,
      },
      select: { id: true },
    });

    return NextResponse.json({ approvalId: approval.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Finish delegated approval failed" },
      { status: 500 }
    );
  }
}
