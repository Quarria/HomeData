CREATE TABLE "share_snapshots" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "family_id" UUID,
  "token_hash" CHAR(64) NOT NULL,
  "passcode_hash" VARCHAR(255),
  "aggregate_payload" JSONB NOT NULL,
  "range_from" DATE NOT NULL,
  "range_to" DATE NOT NULL,
  "period" VARCHAR(8) NOT NULL,
  "scope_label" VARCHAR(80) NOT NULL,
  "generated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "revoked_at" TIMESTAMPTZ(3),
  "invalidated_at" TIMESTAMPTZ(3),
  "purge_after" TIMESTAMPTZ(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  CONSTRAINT "share_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_share_snapshot_range" CHECK ("range_from" <= "range_to"),
  CONSTRAINT "ck_share_snapshot_expiry" CHECK ("expires_at" > "generated_at")
);

CREATE TABLE "share_dependencies" (
  "id" UUID NOT NULL,
  "snapshot_id" UUID NOT NULL,
  "family_id" UUID NOT NULL,
  "membership_id" UUID,
  "required_role" VARCHAR(10) NOT NULL DEFAULT 'MEMBER',
  CONSTRAINT "share_dependencies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_share_dependency_role" CHECK ("required_role" IN ('MEMBER', 'ADMIN'))
);

CREATE TABLE "share_access_sessions" (
  "id" UUID NOT NULL,
  "snapshot_id" UUID NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "share_access_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "share_unlock_attempts" (
  "key_hash" CHAR(64) NOT NULL,
  "window_at" TIMESTAMPTZ(3) NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT "share_unlock_attempts_pkey" PRIMARY KEY ("key_hash"),
  CONSTRAINT "ck_share_unlock_attempts_nonnegative" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "share_snapshots_token_hash_key" ON "share_snapshots"("token_hash");
CREATE INDEX "share_snapshots_owner_id_generated_at_idx" ON "share_snapshots"("owner_id", "generated_at");
CREATE INDEX "share_snapshots_family_id_generated_at_idx" ON "share_snapshots"("family_id", "generated_at");
CREATE INDEX "share_snapshots_expires_at_idx" ON "share_snapshots"("expires_at");
CREATE INDEX "share_snapshots_purge_after_idx" ON "share_snapshots"("purge_after");
CREATE UNIQUE INDEX "share_dependencies_snapshot_id_family_id_key" ON "share_dependencies"("snapshot_id", "family_id");
CREATE INDEX "share_dependencies_family_id_idx" ON "share_dependencies"("family_id");
CREATE UNIQUE INDEX "share_access_sessions_token_hash_key" ON "share_access_sessions"("token_hash");
CREATE INDEX "share_access_sessions_snapshot_id_expires_at_idx" ON "share_access_sessions"("snapshot_id", "expires_at");
CREATE INDEX "share_access_sessions_expires_at_idx" ON "share_access_sessions"("expires_at");

ALTER TABLE "share_snapshots" ADD CONSTRAINT "share_snapshots_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "share_snapshots" ADD CONSTRAINT "share_snapshots_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "share_dependencies" ADD CONSTRAINT "share_dependencies_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "share_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "share_dependencies" ADD CONSTRAINT "share_dependencies_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "share_access_sessions" ADD CONSTRAINT "share_access_sessions_snapshot_id_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "share_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
