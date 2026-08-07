import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await getOrCreateSession();
    const { id } = await props.params;

    const proposal = await prisma.multisigProposal.findUnique({
      where: { id },
      select: {
        id: true,
        multisigAccountId: true,
        targetContractId: true,
        operationKind: true,
        operationParamsJson: true,
        txXdr: true,
        authEntriesXdrJson: true,
        smartAccountAuthEntryIndex: true,
        contextRuleId: true,
        authDigestHex: true,
        signaturePayloadHex: true,
        validUntilLedger: true,
        status: true,
        executedTxHash: true,
        createdAt: true,
      },
    });
    if (!proposal) {
      return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    }

    const acct = await prisma.multisigAccount.findUnique({
      where: { id: proposal.multisigAccountId },
      select: { id: true, userId: true, smartAccountAddress: true, threshold: true },
    });
    if (!acct || acct.userId !== userId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const approvals = await prisma.multisigApproval.findMany({
      where: { proposalId: proposal.id },
      select: {
        id: true,
        approvalType: true,
        memberId: true,
        webauthnSigDataXdrHex: true,
        delegatedSignerAddress: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const members = await prisma.multisigMember.findMany({
      where: { multisigAccountId: acct.id },
      select: { id: true, memberType: true, label: true, keyDataHex: true, gAddress: true },
      orderBy: { createdAt: "asc" },
    });

    return NextResponse.json({
      multisigAccount: {
        smartAccountAddress: acct.smartAccountAddress,
        threshold: acct.threshold,
      },
      proposal: {
        id: proposal.id,
        targetContractId: proposal.targetContractId,
        operationKind: proposal.operationKind,
        operationParams: JSON.parse(proposal.operationParamsJson),
        txXdr: proposal.txXdr,
        authEntriesXdr: JSON.parse(proposal.authEntriesXdrJson),
        smartAccountAuthEntryIndex: proposal.smartAccountAuthEntryIndex,
        contextRuleId: proposal.contextRuleId,
        authDigestHex: proposal.authDigestHex,
        signaturePayloadHex: proposal.signaturePayloadHex,
        validUntilLedger: proposal.validUntilLedger,
        status: proposal.status,
        executedTxHash: proposal.executedTxHash ?? null,
        createdAt: Number(proposal.createdAt),
      },
      members,
      approvals: approvals.map((a) => ({
        id: a.id,
        approvalType: a.approvalType,
        memberId: a.memberId,
        webauthnSigDataXdrHex: a.webauthnSigDataXdrHex ?? null,
        delegatedSignerAddress: a.delegatedSignerAddress ?? null,
        createdAt: Number(a.createdAt),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Get proposal failed" },
      { status: 500 }
    );
  }
}

