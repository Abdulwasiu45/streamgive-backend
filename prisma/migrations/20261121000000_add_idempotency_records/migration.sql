CREATE TABLE "idempotency_records" (
    "key" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "status_code" INTEGER,
    "response" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("key")
);

CREATE INDEX "idempotency_records_expires_at_idx" ON "idempotency_records"("expires_at");
