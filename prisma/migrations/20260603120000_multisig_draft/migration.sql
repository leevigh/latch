-- Multisig draft (server-backed member collection) + credentialId on members

CREATE TABLE "multisig_drafts" (
    "id" TEXT NOT NULL,
    "creator_user_id" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "account_salt_hex" TEXT NOT NULL,
    "invite_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'collecting',
    "predicted_address" TEXT,
    "smart_account_address" TEXT,
    "created_at" BIGINT NOT NULL,
    "expires_at" BIGINT,

    CONSTRAINT "multisig_drafts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "multisig_drafts_invite_token_key" ON "multisig_drafts"("invite_token");
CREATE INDEX "multisig_drafts_creator_idx" ON "multisig_drafts"("creator_user_id");

CREATE TABLE "multisig_draft_members" (
    "id" TEXT NOT NULL,
    "draft_id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "member_type" TEXT NOT NULL,
    "g_address" TEXT,
    "key_data_hex" TEXT,
    "credential_id" TEXT,
    "public_key_hex" TEXT,
    "source" TEXT NOT NULL DEFAULT 'creator',
    "created_at" BIGINT NOT NULL,

    CONSTRAINT "multisig_draft_members_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "multisig_draft_members_draft_idx" ON "multisig_draft_members"("draft_id");

ALTER TABLE "multisig_draft_members" ADD CONSTRAINT "multisig_draft_members_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "multisig_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "multisig_drafts" ADD CONSTRAINT "multisig_drafts_creator_user_id_fkey" FOREIGN KEY ("creator_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "multisig_members" ADD COLUMN IF NOT EXISTS "credential_id" TEXT;
