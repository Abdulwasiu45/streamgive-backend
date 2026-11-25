ALTER TABLE "notification_endpoints"
  ADD COLUMN "previous_secret" TEXT,
  ADD COLUMN "previous_secret_expires_at" TIMESTAMP(3);

ALTER TABLE "webhook_deliveries"
  ADD COLUMN "previous_secret" TEXT,
  ADD COLUMN "previous_secret_expires_at" TIMESTAMP(3);
