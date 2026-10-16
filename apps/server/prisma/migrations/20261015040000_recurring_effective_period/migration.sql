ALTER TABLE "recurring_rules"
ADD COLUMN "effective_from_on" DATE;

UPDATE "recurring_rules"
SET "effective_from_on" = GREATEST(
  "anchor_on",
  ("created_at" AT TIME ZONE 'Asia/Shanghai')::DATE
);

ALTER TABLE "recurring_rules"
ALTER COLUMN "effective_from_on" SET NOT NULL,
ADD CONSTRAINT "ck_recurring_effective_from_on"
CHECK ("effective_from_on" >= "anchor_on");
