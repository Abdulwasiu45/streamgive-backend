ALTER TABLE "ngos" ADD COLUMN "verified_at" TIMESTAMP(3);

-- Best effort backfill: the last update is the closest record we have of
-- when an already verified NGO was approved.
UPDATE "ngos" SET "verified_at" = "updated_at" WHERE "verified" = TRUE;
