CREATE TYPE "TaskStatus" AS ENUM ('OPEN', 'DONE');
CREATE TYPE "RecurringFrequency" AS ENUM ('MONTHLY', 'YEARLY');
CREATE TYPE "RecurringStatus" AS ENUM ('ACTIVE', 'PAUSED');
CREATE TYPE "OccurrenceStatus" AS ENUM ('PENDING', 'PAID', 'SKIPPED');

ALTER TABLE "expenses" ADD COLUMN "occurrence_id" UUID;

CREATE TABLE "tasks" (
  "id" UUID NOT NULL,
  "family_id" UUID,
  "creator_id" UUID NOT NULL,
  "manager_id" UUID NOT NULL,
  "manager_membership_id" UUID,
  "assignee_id" UUID,
  "title" VARCHAR(100) NOT NULL,
  "description" VARCHAR(2000),
  "due_on" DATE NOT NULL,
  "status" "TaskStatus" NOT NULL DEFAULT 'OPEN',
  "completed_by_id" UUID,
  "completed_at" TIMESTAMPTZ(3),
  "deleted_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "recurring_rules" (
  "id" UUID NOT NULL,
  "family_id" UUID,
  "creator_id" UUID NOT NULL,
  "manager_id" UUID NOT NULL,
  "manager_membership_id" UUID,
  "title" VARCHAR(100) NOT NULL,
  "category_id" UUID NOT NULL,
  "frequency" "RecurringFrequency" NOT NULL,
  "anchor_on" DATE NOT NULL,
  "expected_cents" BIGINT,
  "status" "RecurringStatus" NOT NULL DEFAULT 'ACTIVE',
  "schedule_revision" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "recurring_rules_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_recurring_expected_amount" CHECK ("expected_cents" IS NULL OR ("expected_cents" > 0 AND "expected_cents" <= 99999999999))
);

CREATE TABLE "occurrences" (
  "id" UUID NOT NULL,
  "rule_id" UUID NOT NULL,
  "period_key" VARCHAR(7) NOT NULL,
  "due_on" DATE NOT NULL,
  "title_snapshot" VARCHAR(100) NOT NULL,
  "category_id_snapshot" UUID NOT NULL,
  "expected_cents" BIGINT,
  "manager_id" UUID NOT NULL,
  "status" "OccurrenceStatus" NOT NULL DEFAULT 'PENDING',
  "active_expense_id" UUID,
  "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "schedule_revision" INTEGER NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "occurrences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_occurrence_expected_amount" CHECK ("expected_cents" IS NULL OR ("expected_cents" > 0 AND "expected_cents" <= 99999999999))
);

CREATE TABLE "reminder_preferences" (
  "account_id" UUID NOT NULL,
  "local_time" VARCHAR(5) NOT NULL DEFAULT '09:00',
  "task_advance_days" INTEGER NOT NULL DEFAULT 1,
  "fee_advance_days" INTEGER NOT NULL DEFAULT 3,
  "overdue_enabled" BOOLEAN NOT NULL DEFAULT true,
  CONSTRAINT "reminder_preferences_pkey" PRIMARY KEY ("account_id"),
  CONSTRAINT "ck_reminder_advance_days" CHECK ("task_advance_days" BETWEEN 0 AND 30 AND "fee_advance_days" BETWEEN 0 AND 30)
);

CREATE TABLE "inbox_messages" (
  "id" UUID NOT NULL,
  "recipient_id" UUID NOT NULL,
  "slot_at" TIMESTAMPTZ(3) NOT NULL,
  "state" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  "read_at" TIMESTAMPTZ(3),
  "frozen_at" TIMESTAMPTZ(3),
  "payload_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "inbox_messages_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "inbox_items" (
  "id" UUID NOT NULL,
  "message_id" UUID NOT NULL,
  "subject_type" VARCHAR(24) NOT NULL,
  "subject_id" UUID NOT NULL,
  "reminder_kind" VARCHAR(24) NOT NULL,
  "scheduled_on" DATE NOT NULL,
  CONSTRAINT "inbox_items_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ux_inbox_recipient_slot" ON "inbox_messages"("recipient_id", "slot_at");
CREATE INDEX "inbox_messages_recipient_id_read_at_created_at_idx" ON "inbox_messages"("recipient_id", "read_at", "created_at");
CREATE UNIQUE INDEX "ux_inbox_item_dedupe" ON "inbox_items"("message_id", "subject_type", "subject_id", "reminder_kind", "scheduled_on");
CREATE INDEX "inbox_items_subject_type_subject_id_idx" ON "inbox_items"("subject_type", "subject_id");
CREATE INDEX "tasks_family_id_status_due_on_idx" ON "tasks"("family_id", "status", "due_on");
CREATE INDEX "tasks_manager_id_status_due_on_idx" ON "tasks"("manager_id", "status", "due_on");
CREATE INDEX "expenses_occurrence_id_idx" ON "expenses"("occurrence_id");
CREATE INDEX "recurring_rules_family_id_status_idx" ON "recurring_rules"("family_id", "status");
CREATE INDEX "recurring_rules_manager_id_status_idx" ON "recurring_rules"("manager_id", "status");
CREATE UNIQUE INDEX "occurrences_rule_id_period_key_key" ON "occurrences"("rule_id", "period_key");
CREATE UNIQUE INDEX "occurrences_active_expense_id_key" ON "occurrences"("active_expense_id");
CREATE INDEX "occurrences_due_on_status_idx" ON "occurrences"("due_on", "status");

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_id_fkey" FOREIGN KEY ("completed_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "recurring_rules" ADD CONSTRAINT "recurring_rules_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "recurring_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_category_id_snapshot_fkey" FOREIGN KEY ("category_id_snapshot") REFERENCES "categories"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "occurrences" ADD CONSTRAINT "occurrences_active_expense_id_fkey" FOREIGN KEY ("active_expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "occurrences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "reminder_preferences" ADD CONSTRAINT "reminder_preferences_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inbox_messages" ADD CONSTRAINT "inbox_messages_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "inbox_items" ADD CONSTRAINT "inbox_items_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "inbox_messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
