ALTER TYPE "AiRunType" ADD VALUE 'WARDROBE_RECOGNITION';
ALTER TYPE "AiRunType" ADD VALUE 'WARDROBE_RECOMMENDATION';

ALTER TABLE "ai_runs" ADD COLUMN "wardrobe_image_id" UUID;
ALTER TABLE "ai_daily_usage" ALTER COLUMN "bucket" TYPE VARCHAR(32);
ALTER TABLE "ai_daily_usage" DROP CONSTRAINT "ck_ai_usage_bucket";
ALTER TABLE "ai_daily_usage" ADD CONSTRAINT "ck_ai_usage_bucket"
  CHECK ("bucket" IN ('recognition', 'analysis', 'wardrobe_recognition', 'wardrobe_recommendation'));

CREATE TYPE "GarmentCategory" AS ENUM ('TOP', 'OUTERWEAR', 'BOTTOM', 'ONE_PIECE', 'SHOES', 'ACCESSORY');
CREATE TYPE "GarmentSeason" AS ENUM ('SPRING', 'SUMMER', 'AUTUMN', 'WINTER');
CREATE TYPE "GarmentLayer" AS ENUM ('INNER', 'MID', 'OUTER');
CREATE TYPE "GarmentScene" AS ENUM ('COMMUTE', 'CASUAL', 'SPORT');
CREATE TYPE "GarmentStatus" AS ENUM ('WEARABLE', 'LAUNDERING', 'STORED', 'RETIRED');
CREATE TYPE "GarmentVisibility" AS ENUM ('PRIVATE', 'FAMILY');
CREATE TYPE "OutfitItemRole" AS ENUM ('TOP', 'MID', 'OUTER', 'BOTTOM', 'ONE_PIECE', 'SHOES', 'ACCESSORY');

CREATE TABLE "wardrobe_images" (
  "id" UUID NOT NULL,
  "uploaded_by_id" UUID NOT NULL,
  "storage_key" VARCHAR(255) NOT NULL,
  "thumbnail_key" VARCHAR(255) NOT NULL,
  "mime_type" VARCHAR(40) NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "width" INTEGER NOT NULL,
  "height" INTEGER NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wardrobe_images_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_wardrobe_image_dimensions" CHECK ("size_bytes" > 0 AND "width" > 0 AND "height" > 0)
);

CREATE TABLE "garments" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "created_by_id" UUID NOT NULL,
  "family_id" UUID,
  "main_image_id" UUID NOT NULL,
  "expense_id" UUID,
  "name" VARCHAR(100) NOT NULL,
  "category" "GarmentCategory" NOT NULL,
  "color" VARCHAR(40),
  "seasons" "GarmentSeason"[] NOT NULL DEFAULT ARRAY[]::"GarmentSeason"[],
  "layers" "GarmentLayer"[] NOT NULL DEFAULT ARRAY[]::"GarmentLayer"[],
  "scenes" "GarmentScene"[] NOT NULL DEFAULT ARRAY[]::"GarmentScene"[],
  "status" "GarmentStatus" NOT NULL DEFAULT 'WEARABLE',
  "visibility" "GarmentVisibility" NOT NULL DEFAULT 'PRIVATE',
  "storage_location" VARCHAR(100),
  "notes" VARCHAR(500),
  "acquired_on" DATE,
  "version" INTEGER NOT NULL DEFAULT 1,
  "deleted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "garments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_garments_visibility_family" CHECK (("visibility" = 'PRIVATE' AND "family_id" IS NULL) OR ("visibility" = 'FAMILY' AND "family_id" IS NOT NULL)),
  CONSTRAINT "ck_garments_version" CHECK ("version" > 0)
);

CREATE TABLE "garment_shares" (
  "id" UUID NOT NULL,
  "garment_id" UUID NOT NULL,
  "membership_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "garment_shares_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "outfits" (
  "id" UUID NOT NULL,
  "owner_id" UUID NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "scene" "GarmentScene",
  "notes" VARCHAR(500),
  "weather_snapshot" JSONB,
  "version" INTEGER NOT NULL DEFAULT 1,
  "deleted_at" TIMESTAMPTZ(3),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,
  CONSTRAINT "outfits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_outfits_version" CHECK ("version" > 0)
);

CREATE TABLE "outfit_items" (
  "id" UUID NOT NULL,
  "outfit_id" UUID NOT NULL,
  "garment_id" UUID NOT NULL,
  "role" "OutfitItemRole" NOT NULL,
  "sort_order" INTEGER NOT NULL,
  CONSTRAINT "outfit_items_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "wardrobe_weather_cache" (
  "id" UUID NOT NULL,
  "location_key" VARCHAR(120) NOT NULL,
  "timezone" VARCHAR(64) NOT NULL,
  "forecast_from" DATE NOT NULL,
  "forecast_to" DATE NOT NULL,
  "data" JSONB NOT NULL,
  "fetched_at" TIMESTAMPTZ(3) NOT NULL,
  "expires_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "wardrobe_weather_cache_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ck_wardrobe_weather_range" CHECK ("forecast_to" >= "forecast_from")
);

CREATE UNIQUE INDEX "wardrobe_images_storage_key_key" ON "wardrobe_images"("storage_key");
CREATE UNIQUE INDEX "wardrobe_images_thumbnail_key_key" ON "wardrobe_images"("thumbnail_key");
CREATE INDEX "wardrobe_images_uploaded_by_id_created_at_idx" ON "wardrobe_images"("uploaded_by_id", "created_at");
CREATE INDEX "wardrobe_images_content_hash_idx" ON "wardrobe_images"("content_hash");
CREATE UNIQUE INDEX "garments_main_image_id_key" ON "garments"("main_image_id");
CREATE INDEX "garments_owner_id_deleted_at_status_id_idx" ON "garments"("owner_id", "deleted_at", "status", "id");
CREATE INDEX "garments_family_id_visibility_deleted_at_idx" ON "garments"("family_id", "visibility", "deleted_at");
CREATE INDEX "garments_expense_id_idx" ON "garments"("expense_id");
CREATE UNIQUE INDEX "garment_shares_garment_id_membership_id_key" ON "garment_shares"("garment_id", "membership_id");
CREATE INDEX "garment_shares_membership_id_idx" ON "garment_shares"("membership_id");
CREATE INDEX "outfits_owner_id_deleted_at_updated_at_idx" ON "outfits"("owner_id", "deleted_at", "updated_at");
CREATE UNIQUE INDEX "outfit_items_outfit_id_garment_id_key" ON "outfit_items"("outfit_id", "garment_id");
CREATE INDEX "outfit_items_garment_id_idx" ON "outfit_items"("garment_id");
CREATE UNIQUE INDEX "wardrobe_weather_cache_location_key_forecast_from_forecast_to_key" ON "wardrobe_weather_cache"("location_key", "forecast_from", "forecast_to");
CREATE INDEX "wardrobe_weather_cache_expires_at_idx" ON "wardrobe_weather_cache"("expires_at");

ALTER TABLE "wardrobe_images" ADD CONSTRAINT "wardrobe_images_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "garments" ADD CONSTRAINT "garments_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "garments" ADD CONSTRAINT "garments_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "garments" ADD CONSTRAINT "garments_family_id_fkey" FOREIGN KEY ("family_id") REFERENCES "families"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "garments" ADD CONSTRAINT "garments_main_image_id_fkey" FOREIGN KEY ("main_image_id") REFERENCES "wardrobe_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "garments" ADD CONSTRAINT "garments_expense_id_fkey" FOREIGN KEY ("expense_id") REFERENCES "expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "garment_shares" ADD CONSTRAINT "garment_shares_garment_id_fkey" FOREIGN KEY ("garment_id") REFERENCES "garments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "garment_shares" ADD CONSTRAINT "garment_shares_membership_id_fkey" FOREIGN KEY ("membership_id") REFERENCES "memberships"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outfits" ADD CONSTRAINT "outfits_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outfit_items" ADD CONSTRAINT "outfit_items_outfit_id_fkey" FOREIGN KEY ("outfit_id") REFERENCES "outfits"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "outfit_items" ADD CONSTRAINT "outfit_items_garment_id_fkey" FOREIGN KEY ("garment_id") REFERENCES "garments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_wardrobe_image_id_fkey" FOREIGN KEY ("wardrobe_image_id") REFERENCES "wardrobe_images"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
