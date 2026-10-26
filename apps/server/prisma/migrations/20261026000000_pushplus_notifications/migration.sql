ALTER TABLE "reminder_preferences"
ADD COLUMN "pushplus_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "pushplus_enabled_at" TIMESTAMPTZ(3),
ADD COLUMN "pushplus_token" TEXT;

CREATE TABLE "push_deliveries" (
    "id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "provider_id" VARCHAR(128),
    "last_error" VARCHAR(500),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "push_deliveries_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "push_deliveries_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "inbox_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "push_deliveries_message_id_key" ON "push_deliveries"("message_id");
CREATE INDEX "push_deliveries_status_next_attempt_at_idx" ON "push_deliveries"("status", "next_attempt_at");
