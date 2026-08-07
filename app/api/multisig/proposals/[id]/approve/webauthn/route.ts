import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";
import { nowMs } from "@/lib/db";

export const runtime = "nodejs";

type Body = {
  memberId: string;
  sigDataXdrHex: string;
};

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await getOrCreateSession();
    const { id: proposalId } = await props.params;
    const body = (await request.json()) as Body;
    const now = nowMs();

    if (!body?.memberId || typeof body.memberId !== "string") {
      return NextResponse.json({ error: "Missing memberId" }, { status: 400 });
    }
    if (!body?.sigDataXdrHex || typeof body.sigDataXdrHex !== "string") {
      return NextResponse.json({ error: "Missing sigDataXdrHex" }, { status: 400 });
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
      select: { id: true, multisigAccountId: true, memberType: true },
    });
    if (!member || member.multisigAccountId !== acct.id) {
      return NextResponse.json({ error: "Member not found for this account" }, { status: 404 });
    }
    if (member.memberType !== "webauthn") {
      return NextResponse.json({ error: "Member is not webauthn type" }, { status: 400 });
    }

    const approval = await prisma.multisigApproval.upsert({
      where: { proposalId_memberId: { proposalId, memberId: body.memberId } },
      create: {
        proposalId,
        memberId: body.memberId,
        approvalType: "webauthn",
        webauthnSigDataXdrHex: body.sigDataXdrHex.toLowerCase(),
        createdAt: BigInt(now),
      },
      update: {
        approvalType: "webauthn",
        webauthnSigDataXdrHex: body.sigDataXdrHex.toLowerCase(),
      },
      select: { id: true },
    });

    return NextResponse.json({ approvalId: approval.id });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Approve failed" },
      { status: 500 }
    );
  }
}

