import { NextRequest, NextResponse } from "next/server";
import { Networks, rpc, TransactionBuilder, Transaction, xdr } from "@stellar/stellar-sdk";
import { prisma } from "@/lib/prisma";
import { getOrCreateSession } from "@/lib/session";
import {
  buildMultisigExecuteAuthEntries,
  pickApprovalsForThreshold,
} from "@/lib/multisig-execute-auth";
import {
  ProposalRefreshRequiredError,
  PROPOSAL_REFRESHED_CODE,
  ensureMultisigProposalFresh,
} from "@/lib/multisig-proposal-artifacts";
import { rebuildTxWithAuthEntries, submitWithBundler } from "@/lib/soroban-transaction-submit";

export const runtime = "nodejs";

const getConfig = () => ({
  rpcUrl: process.env.NEXT_PUBLIC_RPC_URL || "https://soroban-testnet.stellar.org",
  networkPassphrase: process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE || Networks.TESTNET,
  bundlerSecret: process.env.BUNDLER_SECRET,
  webauthnVerifierAddress: process.env.NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS,
});

export async function POST(
  _request: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  const config = getConfig();
  if (!config.bundlerSecret) {
    return NextResponse.json({ error: "BUNDLER_SECRET is not set." }, { status: 500 });
  }
  if (!config.webauthnVerifierAddress) {
    return NextResponse.json(
      { error: "NEXT_PUBLIC_WEBAUTHN_VERIFIER_ADDRESS is not set." },
      { status: 500 }
    );
  }

  try {
    const { userId } = await getOrCreateSession();
    const { id: proposalId } = await props.params;
    const server = new rpc.Server(config.rpcUrl);

    const proposal = await prisma.multisigProposal.findUnique({
      where: { id: proposalId },
      select: {
        id: true,
        multisigAccountId: true,
        txXdr: true,
        authEntriesXdrJson: true,
        smartAccountAuthEntryIndex: true,
        contextRuleId: true,
        status: true,
        executedTxHash: true,
      },
    });
    if (!proposal) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });
    if (proposal.status !== "pending") {
      return NextResponse.json(
        { error: `Proposal not pending (status=${proposal.status})` },
        { status: 409 }
      );
    }

    const acct = await prisma.multisigAccount.findUnique({
      where: { id: proposal.multisigAccountId },
      select: { id: true, userId: true, smartAccountAddress: true, threshold: true },
    });
    if (!acct || acct.userId !== userId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    try {
      await ensureMultisigProposalFresh({
        proposalId,
        server,
        networkPassphrase: config.networkPassphrase,
        bundlerSecret: config.bundlerSecret,
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

    const proposalLive = await prisma.multisigProposal.findUnique({
      where: { id: proposalId },
      select: {
        id: true,
        txXdr: true,
        authEntriesXdrJson: true,
        smartAccountAuthEntryIndex: true,
        contextRuleId: true,
      },
    });
    if (!proposalLive) return NextResponse.json({ error: "Proposal not found" }, { status: 404 });

    const approvals = await prisma.multisigApproval.findMany({
      where: { proposalId: proposal.id },
      select: {
        approvalType: true,
        webauthnSigDataXdrHex: true,
        delegatedEntryTemplateXdr: true,
        delegatedSignedAuthEntryBase64: true,
        delegatedSignerAddress: true,
        member: { select: { memberType: true, keyDataHex: true, gAddress: true } },
      },
    });

    // Count approvals with usable signature material.
    const webauthnApprovals = approvals
      .filter((a) => a.approvalType === "webauthn" && a.member.memberType === "webauthn")
      .filter((a) => !!a.webauthnSigDataXdrHex && !!a.member.keyDataHex);
    const delegatedApprovals = approvals
      .filter((a) => a.approvalType === "delegated" && a.member.memberType === "delegated")
      .filter((a) => !!a.delegatedEntryTemplateXdr && !!a.delegatedSignedAuthEntryBase64 && !!a.delegatedSignerAddress && !!a.member.gAddress);

    const approvalCount = webauthnApprovals.length + delegatedApprovals.length;
    if (approvalCount < acct.threshold) {
      return NextResponse.json(
        { error: `Threshold not met: have ${approvalCount}, need ${acct.threshold}` },
        { status: 409 }
      );
    }

    const { webauthn: webauthnUsed, delegated: delegatedUsed } = pickApprovalsForThreshold(
      acct.threshold,
      webauthnApprovals,
      delegatedApprovals
    );

    const authEntriesXdr: string[] = JSON.parse(proposalLive.authEntriesXdrJson);
    const entries = authEntriesXdr.map((b64) => xdr.SorobanAuthorizationEntry.fromXDR(b64, "base64"));

    const finalEntries = buildMultisigExecuteAuthEntries({
      entries,
      smartAccountAuthEntryIndex: proposalLive.smartAccountAuthEntryIndex,
      contextRuleId: proposalLive.contextRuleId,
      networkPassphrase: config.networkPassphrase,
      webauthnVerifierAddress: config.webauthnVerifierAddress!,
      webauthnApprovals: webauthnUsed,
      delegatedApprovals: delegatedUsed,
    });

    const tx = TransactionBuilder.fromXDR(proposalLive.txXdr, config.networkPassphrase) as Transaction;
    const txWithAuth = rebuildTxWithAuthEntries(tx, config.networkPassphrase, finalEntries);

    const { hash: txHash, status } = await submitWithBundler({
      server,
      networkPassphrase: config.networkPassphrase,
      bundlerSecret: config.bundlerSecret,
      txWithAuth,
    });

    await prisma.multisigProposal.update({
      where: { id: proposal.id },
      data: { status: "executed", executedTxHash: txHash },
    });

    return NextResponse.json({ hash: txHash, status });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Execute failed" },
      { status: 500 }
    );
  }
}

