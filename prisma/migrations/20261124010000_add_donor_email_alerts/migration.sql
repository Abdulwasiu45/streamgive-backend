CREATE TABLE "donor_email_alerts" (
    "id" TEXT NOT NULL,
    "donor_address" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "verification_token_hash" TEXT,
    "verification_expires_at" TIMESTAMP(3),
    "last_verification_sent_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "unsubscribe_token" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "donor_email_alerts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "donor_email_alerts_verification_token_hash_key" ON "donor_email_alerts"("verification_token_hash");

CREATE UNIQUE INDEX "donor_email_alerts_unsubscribe_token_key" ON "donor_email_alerts"("unsubscribe_token");

CREATE UNIQUE INDEX "donor_email_alerts_donor_address_email_key" ON "donor_email_alerts"("donor_address", "email");

CREATE INDEX "donor_email_alerts_donor_address_idx" ON "donor_email_alerts"("donor_address");
