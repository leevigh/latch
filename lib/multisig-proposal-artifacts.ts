import "server-only";

import { Address, Contract, Keypair, Operation, rpc } from "@stellar/stellar-sdk";
import { prisma } from "@/lib/prisma";
import {
  ProposalRefreshRequiredError,
  PROPOSAL_REFRESHED_CODE,
} from "@/lib/multisig-proposal-refresh";
import {
  buildAuthTransaction,
  buildSacTransferOperation,
  type BuildAuthTransactionResult,
} from "@/lib/soroban-transaction-build";

export { ProposalRefreshRequiredError, PROPOSAL_REFRESHED_CODE };

/** Ledgers until Soroban auth entries expire (~5s/ledger on testnet → ~14h at 10k). */
export const MULTISIG_AUTH_LEDGER_TTL = 10_000;

export async function getLatestLedgerSequence(server: rpc.Server): Promise<number> {
  const latest = await server.getLatestLedger();
  return latest.sequence;
}

export function isProposalAuthExpired(
  validUntilLedger: number,
  latestLedger: number,
  safetyLedgers = 25
): boolean {
  return latestLedger >= validUntilLedger - safetyLedgers;
}

type ProposalRow = {
  id: string;
  multisigAccountId: string;
  targetContractId: string;
  operationKind: string;
  operationParamsJson: string;
  validUntilLedger: number;
  authDigestHex: string;
  multisigAccount: { smartAccountAddress: string };
};

async function loadProposalForRebuild(proposalId: string): Promise<ProposalRow | null> {
  const row = await prisma.multisigProposal.findUnique({
    where: { id: proposalId },
    select: {
      id: true,
      multisigAccountId: true,
      targetContractId: true,
      operationKind: true,
      operationParamsJson: true,
      validUntilLedger: true,
      authDigestHex: true,
      multisigAccount: { select: { smartAccountAddress: true } },
    },
  });
  if (!row) return null;
  return {
    ...row,
    multisigAccount: row.multisigAccount,
  };
}

function buildOperationForProposal(
  proposal: ProposalRow,
  smartAccountAddress: string
): (contract: Contract) => Operation {
  const params = JSON.parse(proposal.operationParamsJson) as Record<string, unknown>;
  if (proposal.operationKind === "counter_increment") {
    return (contract: Contract) =>
      contract.call("increment", new Address(smartAccountAddress).toScVal());
  }
  if (proposal.operationKind === "sac_transfer") {
    const tokenContractId = String(params.tokenContractId ?? proposal.targetContractId);
    const recipient = String(params.recipient ?? "");
    const amountI128 = BigInt(String(params.amountI128 ?? "0"));
    if (!tokenContractId || !recipient || amountI128 <= 0n) {
      throw new Error("sac_transfer requires tokenContractId/recipient/amountI128");
    }
    return buildSacTransferOperation(
      tokenContractId,
      smartAccountAddress,
      recipient,
      amountI128
    );
  }
  throw new Error(`Unsupported operationKind: ${proposal.operationKind}`);
}

export async function rebuildMultisigProposalArtifacts(args: {
  proposalId: string;
  server: rpc.Server;
  networkPassphrase: string;
  bundlerSecret: string;
}): Promise<BuildAuthTransactionResult & { validUntilLedger: number; authDigestHex: string }> {
  const proposal = await loadProposalForRebuild(args.proposalId);
  if (!proposal) throw new Error("Proposal not found");

  const smartAccountAddress = proposal.multisigAccount.smartAccountAddress;
  const bundlerKeypair = Keypair.fromSecret(args.bundlerSecret);

  const buildResult = await buildAuthTransaction({
    server: args.server,
    networkPassphrase: args.networkPassphrase,
    bundlerKeypair,
    smartAccountAddress,
    targetContractId: proposal.targetContractId,
    buildOperation: buildOperationForProposal(proposal, smartAccountAddress),
    signerType: "passkey",
    signerG: null,
    authEntryLedgerTtl: MULTISIG_AUTH_LEDGER_TTL,
  });

  await prisma.$transaction([
    prisma.multisigApproval.deleteMany({ where: { proposalId: args.proposalId } }),
    prisma.multisigProposal.update({
      where: { id: args.proposalId },
      data: {
        txXdr: buildResult.txXdr,
        authEntriesXdrJson: JSON.stringify(buildResult.authEntriesXdr),
        smartAccountAuthEntryIndex: buildResult.smartAccountAuthEntryIndex,
        contextRuleId: buildResult.contextRuleId,
        authDigestHex: buildResult.authDigestHex,
        signaturePayloadHex: buildResult.signaturePayloadHex,
        validUntilLedger: buildResult.validUntilLedger,
      },
    }),
  ]);

  return buildResult;
}

/**
 * Re-simulates the proposal when auth entries are near/past expiry.
 * Clears approvals (signatures bind to the old auth digest / ledger window).
 */
export async function ensureMultisigProposalFresh(args: {
  proposalId: string;
  server: rpc.Server;
  networkPassphrase: string;
  bundlerSecret: string;
}): Promise<{ refreshed: boolean; validUntilLedger: number; authDigestHex: string }> {
  const proposal = await loadProposalForRebuild(args.proposalId);
  if (!proposal) throw new Error("Proposal not found");

  const latest = await getLatestLedgerSequence(args.server);
  if (!isProposalAuthExpired(proposal.validUntilLedger, latest)) {
    return {
      refreshed: false,
      validUntilLedger: proposal.validUntilLedger,
      authDigestHex: proposal.authDigestHex,
    };
  }

  await rebuildMultisigProposalArtifacts(args);
  throw new ProposalRefreshRequiredError(
    "Proposal auth window expired. The transaction was rebuilt with a new auth digest — please approve all signers again, then execute."
  );
}
