-- Wardrobe sharing is not part of the product: keep all existing clothing
-- owner-only and remove old membership grants.
DELETE FROM "garment_shares";

UPDATE "garments"
SET "visibility" = 'PRIVATE', "family_id" = NULL
WHERE "visibility" <> 'PRIVATE' OR "family_id" IS NOT NULL;
