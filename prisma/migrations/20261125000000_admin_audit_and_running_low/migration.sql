ALTER TABLE "streams"
ADD COLUMN "running_low_notified_at" TIMESTAMP(3);

CREATE INDEX "streams_status_running_low_notified_at_idx"
ON "streams"("status", "running_low_notified_at");

CREATE TABLE "admin_audit_logs" (
    "id" TEXT NOT NULL,
    "admin_address" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "summary" VARCHAR(240) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "admin_audit_logs_created_at_id_idx"
ON "admin_audit_logs"("created_at", "id");
CREATE INDEX "admin_audit_logs_admin_address_created_at_idx"
ON "admin_audit_logs"("admin_address", "created_at");
CREATE INDEX "admin_audit_logs_action_created_at_idx"
ON "admin_audit_logs"("action", "created_at");
CREATE INDEX "admin_audit_logs_target_id_created_at_idx"
ON "admin_audit_logs"("target_id", "created_at");
