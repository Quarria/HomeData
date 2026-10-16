CREATE TYPE "AiRunType" AS ENUM ('RECEIPT_EXTRACTION', 'ANALYSIS');
CREATE TYPE "AiRunStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED');

CREATE TABLE "ai_runs" (
  "id" UUID NOT NULL,
  "actor_id" UUID NOT NULL,
  "family_id" UUID,
  "membership_id" UUID,
  "receipt_id" UUID,
  "type" "AiRunType" NOT NULL,
  "status" "AiRunStatus" NOT NULL DEFAULT 'PENDING',
  "idempotency_key" UUID NOT NULL,
  "input" JSONB NOT NULL,
  "result" JSONB,
  "error_code" VARCHAR(40),
  "provider_usage" JSONB,
  "usage_date" DATE NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMPTZ(3),
  "finished_at" TIMESTAMPTZ(3),
  CONSTRAINT "ai_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_ai_runs_attempts" CHECK ("attempts" >= 0)
);

CREATE TABLE "ai_daily_usage" (
  "account_id" UUID NOT NULL,
  "usage_date" DATE NOT NULL,
  "bucket" VARCHAR(16) NOT NULL,
  "reserved" INTEGER NOT NULL DEFAULT 0,
  "succeeded" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "ai_daily_usage_pkey" PRIMARY KEY ("account_id", "usage_date", "bucket"),
  CONSTRAINT "ck_ai_usage_counts" CHECK ("reserved" >= 0 AND "succeeded" >= 0),
  CONSTRAINT "ck_ai_usage_bucket" CHECK ("bucket" IN ('recognition', 'analysis'))
);

CREATE UNIQUE INDEX "ai_runs_actor_id_idempotency_key_key" ON "ai_runs"("actor_id", "idempotency_key");
CREATE INDEX "ai_runs_status_created_at_idx" ON "ai_runs"("status", "created_at");
CREATE INDEX "ai_runs_actor_id_created_at_idx" ON "ai_runs"("actor_id", "created_at");
CREATE INDEX "ai_runs_family_id_created_at_idx" ON "ai_runs"("family_id", "created_at");

ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "receipts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_daily_usage" ADD CONSTRAINT "ai_daily_usage_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
