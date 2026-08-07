-- CreateTable
CREATE TABLE "sign_payloads" (
    "id" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "consumed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sign_payloads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sign_payloads_expires_at_idx" ON "sign_payloads"("expires_at");
