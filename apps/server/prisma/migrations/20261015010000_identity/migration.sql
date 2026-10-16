CREATE TYPE "SystemRole" AS ENUM ('USER', 'SYSTEM_ADMIN');
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "FamilyStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

CREATE TABLE "accounts" (
  "id" UUID NOT NULL,
  "username" VARCHAR(40) NOT NULL,
  "username_normalized" VARCHAR(40) NOT NULL,
  "nickname" VARCHAR(80) NOT NULL,
  "password_hash" VARCHAR(255) NOT NULL,
  "system_role" "SystemRole" NOT NULL DEFAULT 'USER',
  "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
  "must_change_password" BOOLEAN NOT NULL DEFAULT true,
  "auth_version" INTEGER NOT NULL DEFAULT 1,
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "accounts_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "sessions" (
  "id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "auth_version" INTEGER NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "families" (
  "id" UUID NOT NULL,
  "name" VARCHAR(80) NOT NULL,
  "admin_account_id" UUID NOT NULL,
  "status" "FamilyStatus" NOT NULL DEFAULT 'ACTIVE',
  "archived_at" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "families_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "memberships" (
  "id" UUID NOT NULL,
  "family_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "left_at" TIMESTAMPTZ(3),
  "leave_reason" VARCHAR(32),
  CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "audit_events" (
  "id" UUID NOT NULL,
  "actor_id" UUID,
  "action" VARCHAR(80) NOT NULL,
  "subject_type" VARCHAR(40) NOT NULL,
  "subject_id" UUID,
  "details" JSONB,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "accounts_username_key" ON "accounts"("username");
CREATE UNIQUE INDEX "accounts_username_normalized_key" ON "accounts"("username_normalized");
CREATE UNIQUE INDEX "sessions_token_hash_key" ON "sessions"("token_hash");
CREATE INDEX "sessions_account_id_idx" ON "sessions"("account_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
CREATE INDEX "families_admin_account_id_status_idx" ON "families"("admin_account_id", "status");
CREATE INDEX "memberships_family_id_left_at_joined_at_idx" ON "memberships"("family_id", "left_at", "joined_at");
CREATE INDEX "memberships_account_id_left_at_idx" ON "memberships"("account_id", "left_at");
CREATE UNIQUE INDEX "ux_one_current_family" ON "memberships"("account_id") WHERE "left_at" IS NULL;
CREATE UNIQUE INDEX "ux_current_member" ON "memberships"("family_id", "account_id") WHERE "left_at" IS NULL;
CREATE INDEX "audit_events_actor_id_created_at_idx" ON "audit_events"("actor_id", "created_at");
CREATE INDEX "audit_events_subject_type_subject_id_created_at_idx" ON "audit_events"("subject_type", "subject_id", "created_at");

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "families" ADD CONSTRAINT "families_admin_account_id_fkey"
  FOREIGN KEY ("admin_account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_family_id_fkey"
  FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_account_id_fkey"
  FOREIGN KEY ("account_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_fkey"
  FOREIGN KEY ("actor_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
