/** Client-safe proposal refresh codes and errors (no Prisma / server-only). */

export const PROPOSAL_REFRESHED_CODE = "PROPOSAL_REFRESHED";

export class ProposalRefreshRequiredError extends Error {
  readonly code = PROPOSAL_REFRESHED_CODE;
  readonly refreshed = true;

  constructor(message: string) {
    super(message);
    this.name = "ProposalRefreshRequiredError";
  }
}
