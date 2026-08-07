-- CreateTable
CREATE TABLE "on_ramp_intents" (
    "id" TEXT NOT NULL,
    "memo_id" TEXT NOT NULL,
    "destination_c_address" TEXT NOT NULL,
    "external_customer_id" TEXT NOT NULL,
    "moonpay_transaction_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'created',
    "fiat_amount" TEXT NOT NULL,
    "fiat_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "on_ramp_intents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "on_ramp_intents_memo_id_key" ON "on_ramp_intents"("memo_id");

-- CreateIndex
CREATE INDEX "on_ramp_intents_status_idx" ON "on_ramp_intents"("status");

-- CreateIndex
CREATE INDEX "on_ramp_intents_customer_idx" ON "on_ramp_intents"("external_customer_id");
