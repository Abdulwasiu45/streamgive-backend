CREATE TYPE "WebhookDeliveryStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED');

CREATE TABLE "webhook_deliveries" (
    "id" TEXT NOT NULL,
    "delivery_key" TEXT NOT NULL,
    "event_id" TEXT,
    "event_type" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT,
    "payload" TEXT NOT NULL,
    "status" "WebhookDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "max_attempts" INTEGER NOT NULL DEFAULT 5,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "locked_until" TIMESTAMP(3),
    "last_error" TEXT,
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "webhook_deliveries_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "webhook_deliveries_delivery_key_key"
    ON "webhook_deliveries"("delivery_key");
CREATE INDEX "webhook_deliveries_status_next_attempt_at_idx"
    ON "webhook_deliveries"("status", "next_attempt_at");
CREATE INDEX "webhook_deliveries_locked_until_idx"
    ON "webhook_deliveries"("locked_until");
