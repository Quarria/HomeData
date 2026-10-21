ALTER TABLE "families"
  ADD COLUMN "default_city_name" VARCHAR(120),
  ADD COLUMN "default_city_country" VARCHAR(2),
  ADD COLUMN "default_city_latitude" DOUBLE PRECISION,
  ADD COLUMN "default_city_longitude" DOUBLE PRECISION,
  ADD COLUMN "default_city_timezone" VARCHAR(64);

ALTER TABLE "families"
  ADD CONSTRAINT "ck_families_default_city_coordinates"
  CHECK (
    ("default_city_latitude" IS NULL AND "default_city_longitude" IS NULL)
    OR ("default_city_latitude" BETWEEN -90 AND 90 AND "default_city_longitude" BETWEEN -180 AND 180)
  );
