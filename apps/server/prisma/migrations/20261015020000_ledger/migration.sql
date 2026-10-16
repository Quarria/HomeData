CREATE TYPE "ReceiptPrivacy" AS ENUM ('PRIVATE', 'FAMILY');

CREATE TABLE "expenses" (
    "id" UUID NOT NULL,
    "payer_id" UUID NOT NULL,
    "family_id" UUID,
    "category_id" UUID NOT NULL,
    "title" VARCHAR(120) NOT NULL,
    "occurred_on" DATE NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "quantity" DECIMAL(12,3),
    "unit" VARCHAR(24),
    "unit_price" DECIMAL(12,2),
    "note" VARCHAR(500),
    "deleted_at" TIMESTAMPTZ(3),
    "purge_after" TIMESTAMPTZ(3),
    "delete_batch_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "expenses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_expense_amount" CHECK ("amount_cents" > 0 AND "amount_cents" <= 99999999999),
    CONSTRAINT "ck_expense_quantity" CHECK ("quantity" IS NULL OR "quantity" > 0),
    CONSTRAINT "ck_expense_unit_pair" CHECK (("quantity" IS NULL) = ("unit" IS NULL)),
    CONSTRAINT "ck_expense_unit_price" CHECK ("unit_price" IS NULL OR ("unit_price" >= 0 AND "quantity" IS NOT NULL))
);

CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "amount_cents" BIGINT NOT NULL,
    "occurred_on" DATE NOT NULL,
    "deleted_at" TIMESTAMPTZ(3),
    "purge_after" TIMESTAMPTZ(3),
    "delete_batch_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_refund_amount" CHECK ("amount_cents" > 0 AND "amount_cents" <= 99999999999)
);

CREATE TABLE "receipts" (
    "id" UUID NOT NULL,
    "uploaded_by_id" UUID NOT NULL,
    "storage_key" VARCHAR(255) NOT NULL,
    "mime_type" VARCHAR(40) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "content_hash" CHAR(64) NOT NULL,
    "privacy_lock" "ReceiptPrivacy" NOT NULL DEFAULT 'PRIVATE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ck_receipt_size" CHECK ("size_bytes" > 0 AND "size_bytes" <= 10485760)
);

CREATE TABLE "receipt_links" (
    "id" UUID NOT NULL,
    "receipt_id" UUID NOT NULL,
    "expense_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "receipt_links_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "idempotency_records" (
    "id" UUID NOT NULL,
    "actor_id" UUID NOT NULL,
    "operation" VARCHAR(80) NOT NULL,
    "key" UUID NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "response" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "receipt_links_receipt_id_expense_id_key" ON "receipt_links"("receipt_id", "expense_id");
CREATE UNIQUE INDEX "receipts_storage_key_key" ON "receipts"("storage_key");
CREATE INDEX "expenses_payer_id_occurred_on_id_idx" ON "expenses"("payer_id", "occurred_on", "id");
CREATE INDEX "expenses_family_id_occurred_on_id_idx" ON "expenses"("family_id", "occurred_on", "id");
CREATE INDEX "expenses_category_id_occurred_on_idx" ON "expenses"("category_id", "occurred_on");
CREATE INDEX "expenses_deleted_at_purge_after_idx" ON "expenses"("deleted_at", "purge_after");
CREATE INDEX "refunds_expense_id_occurred_on_idx" ON "refunds"("expense_id", "occurred_on");
CREATE INDEX "refunds_deleted_at_purge_after_idx" ON "refunds"("deleted_at", "purge_after");
CREATE INDEX "receipts_uploaded_by_id_created_at_idx" ON "receipts"("uploaded_by_id", "created_at");
CREATE INDEX "receipt_links_expense_id_idx" ON "receipt_links"("expense_id");
CREATE UNIQUE INDEX "idempotency_records_actor_id_operation_key_key" ON "idempotency_records"("actor_id", "operation", "key");
CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");

ALTER TABLE "expenses" ADD CONSTRAINT "expenses_payer_id_fkey" FOREIGN KEY ("payer_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipts" ADD CONSTRAINT "receipts_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt_links" ADD CONSTRAINT "receipt_links_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "receipt_links" ADD CONSTRAINT "receipt_links_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
