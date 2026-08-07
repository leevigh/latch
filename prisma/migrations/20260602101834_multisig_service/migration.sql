-- CreateTable
CREATE TABLE "multisig_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "smart_account_address" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "account_salt_hex" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "multisig_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "multisig_members" (
    "id" TEXT NOT NULL,
    "multisig_account_id" TEXT NOT NULL,
    "member_type" TEXT NOT NULL,
    "label" TEXT,
    "key_data_hex" TEXT,
    "g_address" TEXT,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "multisig_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "multisig_proposals" (
    "id" TEXT NOT NULL,
    "multisig_account_id" TEXT NOT NULL,
    "created_by_user_id" TEXT NOT NULL,
    "target_contract_id" TEXT NOT NULL,
    "operation_kind" TEXT NOT NULL,
    "operation_params_json" TEXT NOT NULL,
    "tx_xdr" TEXT NOT NULL,
    "auth_entries_xdr_json" TEXT NOT NULL,
    "smart_account_auth_entry_index" INTEGER NOT NULL,
    "context_rule_id" INTEGER NOT NULL,
    "auth_digest_hex" TEXT NOT NULL,
    "signature_payload_hex" TEXT NOT NULL,
    "valid_until_ledger" INTEGER NOT NULL,
    "status" TEXT NOT NULL,
    "executed_tx_hash" TEXT,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "multisig_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "multisig_approvals" (
    "id" TEXT NOT NULL,
    "proposal_id" TEXT NOT NULL,
    "member_id" TEXT NOT NULL,
    "approval_type" TEXT NOT NULL,
    "webauthn_sig_data_xdr_hex" TEXT,
    "delegated_entry_template_xdr" TEXT,
    "delegated_signed_auth_entry_base64" TEXT,
    "delegated_signer_address" TEXT,
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "multisig_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "multisig_accounts_smart_account_address_key" ON "multisig_accounts"("smart_account_address");

-- CreateIndex
CREATE INDEX "multisig_accounts_user_id_idx" ON "multisig_accounts"("user_id");

-- CreateIndex
CREATE INDEX "multisig_members_acct_idx" ON "multisig_members"("multisig_account_id");

-- CreateIndex
CREATE INDEX "multisig_members_acct_type_idx" ON "multisig_members"("multisig_account_id", "member_type");

-- CreateIndex
CREATE INDEX "multisig_proposals_acct_status_idx" ON "multisig_proposals"("multisig_account_id", "status");

-- CreateIndex
CREATE INDEX "multisig_proposals_created_by_idx" ON "multisig_proposals"("created_by_user_id");

-- CreateIndex
CREATE INDEX "multisig_approvals_proposal_idx" ON "multisig_approvals"("proposal_id");

-- CreateIndex
CREATE UNIQUE INDEX "multisig_approvals_proposal_member_uniq" ON "multisig_approvals"("proposal_id", "member_id");

-- AddForeignKey
ALTER TABLE "multisig_accounts" ADD CONSTRAINT "multisig_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multisig_members" ADD CONSTRAINT "multisig_members_multisig_account_id_fkey" FOREIGN KEY ("multisig_account_id") REFERENCES "multisig_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multisig_proposals" ADD CONSTRAINT "multisig_proposals_multisig_account_id_fkey" FOREIGN KEY ("multisig_account_id") REFERENCES "multisig_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multisig_approvals" ADD CONSTRAINT "multisig_approvals_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "multisig_proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "multisig_approvals" ADD CONSTRAINT "multisig_approvals_member_id_fkey" FOREIGN KEY ("member_id") REFERENCES "multisig_members"("id") ON DELETE CASCADE ON UPDATE CASCADE;
