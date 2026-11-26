# Running more than one instance

The backend is one Node.js process that serves the HTTP API and also runs the
indexer, the webhook delivery worker and the log retention job. Starting a
second instance starts all of these again. This guide lists what the
instances share through PostgreSQL, what each instance keeps to itself, what
can go wrong, and the settings to use.

It describes the code as it is today. The short version: **one instance is
the supported setup.** Two or more instances work, and the database-backed
pieces stay correct, but several protections become per instance.

## Shared through the database

These are correct with any number of instances, because PostgreSQL is the
single source of truth or the coordination point.

| What                              | How it is coordinated                                                                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application data                  | NGOs, donors, streams, events, applications and notification endpoints are all stored in PostgreSQL. Every instance reads and writes the same rows.                                                                                                                                                                                                                                                       |
| Indexer                           | Every instance starts the indexer, but it must hold a session-level PostgreSQL advisory lock (`pg_try_advisory_lock`, in [`src/indexer/lock.ts`](../src/indexer/lock.ts)) before it polls. Only one instance holds it. The others try again every `INDEXER_POLL_INTERVAL_MS`. If the holder dies, its connection closes, the lock is released, and another instance takes over from the saved checkpoint. |
| Indexer checkpoint                | Stored in `indexer_checkpoints`, so the instance that takes over resumes where the last one stopped.                                                                                                                                                                                                                                                                                                      |
| Webhook delivery outbox           | Deliveries are rows in `webhook_deliveries`. Every instance runs the delivery worker, but a worker claims a row with a conditional update on `attempts` and `lockedUntil`, so only one instance sends a given attempt. `deliveryKey` is unique, so the same event is queued only once per destination.                                                                                                    |
| NGO application submission        | Takes a transaction-scoped advisory lock on the owner address (`pg_advisory_xact_lock`), so two instances cannot both create a pending application for the same owner.                                                                                                                                                                                                                                    |
| Application challenges            | Stored in `ngo_application_challenges` and consumed with a delete. A challenge issued by one instance can be used on another, and only once.                                                                                                                                                                                                                                                              |
| Contact email verification tokens | Stored as hashes in `ngo_application_contact_challenges` and consumed with a delete inside a transaction.                                                                                                                                                                                                                                                                                                 |
| Idempotency keys                  | Stored in `idempotency_records`. The first request inserts a placeholder row, so a retry that lands on another instance gets the stored response or `409 idempotency_request_in_progress`.                                                                                                                                                                                                                |
| Readiness (`GET /health/ready`)   | Compares the latest ledger with the checkpoint in the database, so every instance reports the same indexer lag, including instances that do not hold the indexer lock.                                                                                                                                                                                                                                    |

## Kept per instance

These live in process memory. Each instance has its own copy, and a restart
clears it.

| What                              | Where                                                                                    | Effect with several instances                                                                                                                                                                                  |
| --------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Admin signature replay cache      | `usedSignatures` in [`src/middleware/adminAuth.ts`](../src/middleware/adminAuth.ts)      | A signed admin request already used on instance A is accepted once more on instance B within the five-minute timestamp window. See [ADR-0003](adr/0003-keep-admin-signature-replay-state-in-memory.md).        |
| Owner signature replay cache      | `usedOwnerSignatures` in [`src/middleware/ownerAuth.ts`](../src/middleware/ownerAuth.ts) | Same as above for `x-owner-*` requests, such as `PATCH /v1/ngos/{id}/profile`.                                                                                                                                 |
| Rate limits                       | `@fastify/rate-limit` with its default in-memory store                                   | Each instance counts separately. A client spread across N instances gets up to N times `RATE_LIMIT_MAX`, and up to N times `RATE_LIMIT_APPLICATION_MAX` for application submissions and contact-email resends. |
| Notification de-duplication cache | `deliveredEventIds` in [`src/notifications/service.ts`](../src/notifications/service.ts) | Only a fast path. The unique `deliveryKey` in `webhook_deliveries` and the `notification_logs` check are what stop duplicates, and both are in the database.                                                   |
| Metrics                           | [`src/metrics.ts`](../src/metrics.ts)                                                    | `GET /metrics` returns the counters of the instance that answered. Scrape each instance directly, not through the load balancer, and sum in Prometheus.                                                        |
| Log retention timer               | [`src/maintenance/logRetention.ts`](../src/maintenance/logRetention.ts)                  | Every instance runs the daily prune. The deletes are idempotent, so this is harmless but redundant.                                                                                                            |
| Configuration                     | Environment variables, read at start-up                                                  | Each instance reads its own. `MAINTENANCE_MODE`, `ADMIN_ADDRESSES`, `LOG_RETENTION_DAYS` and the rate-limit values must match on every instance, or behaviour depends on which instance answers.               |

## Risks

1. **Signature replay across instances.** An attacker who captures a signed
   admin or owner request can replay it once against each other instance
   within five minutes. Admin and owner routes are writes, so a replay
   repeats the action. Keep TLS end to end and do not log request headers.
2. **Weaker rate limits.** Limits scale with the number of instances. Behind
   a load balancer that spreads one client across instances, the limit a
   client sees can be several times the configured value.
3. **Wrong client IP.** Rate limits key on `request.ip`. Behind a proxy or
   load balancer, `TRUST_PROXY` must be set so the IP comes from
   `X-Forwarded-For`; otherwise every request appears to come from the
   proxy and all clients share one budget per instance. See
   [HARDENING.md](HARDENING.md).
4. **Misleading metrics.** Scraping `/metrics` through the load balancer
   returns a different instance on each scrape, so counters appear to jump
   up and down.
5. **More database connections.** Each instance has its own Prisma
   connection pool, and the indexer lock uses one extra connection. Instances
   that do not hold the lock open and close a connection every
   `INDEXER_POLL_INTERVAL_MS` while they retry. Check that the total fits the
   database's connection limit, which is low on hosted free tiers.
6. **Indexer handover gap.** After the lock holder stops, another instance
   takes over at its next poll, so indexing pauses for up to one poll
   interval, longer if that instance is backing off after errors.
7. **Mixed versions during a rolling deploy.** Old and new instances run
   side by side and share one database. Apply migrations that both versions
   can run against before rolling out. See
   [PRODUCTION-MIGRATIONS.md](PRODUCTION-MIGRATIONS.md).

## Recommended settings

**Run one instance** unless you need more capacity or availability than one
process gives. One instance keeps every protection above at full strength.

If you run more than one:

- Use **sticky sessions** (client-IP affinity) on the load balancer. Each
  client then hits one instance, which keeps its rate limit and replay cache
  in one place. This reduces risks 1 and 2 without removing them.
- Set `TRUST_PROXY` to match your proxy chain (see
  [ENVIRONMENT.md](../ENVIRONMENT.md) and [HARDENING.md](HARDENING.md)).
- **Divide the rate limits** by the number of instances if you need the
  configured value to hold overall, for example `RATE_LIMIT_MAX=50` on each
  of two instances for an overall limit of about 100.
- Give every instance the **same environment**, especially
  `MAINTENANCE_MODE`, `ADMIN_ADDRESSES`, rate-limit settings and
  `LOG_RETENTION_DAYS`. Change them on all instances together.
- **Scrape each instance** for metrics, using its own address, and set
  `METRICS_TOKEN` on all of them.
- Use `GET /health/ready` for load balancer readiness. It is correct on every
  instance. Alert on `streamgive_indexer_lag_ledgers` from any instance.
- Keep the database connection budget in mind: instances × pool size, plus
  one connection for the indexer lock.
- Keep `INDEXER_POLL_INTERVAL_MS` at its default unless you need a faster
  handover, since lower values also raise the rate of lock attempts from
  standby instances.

## What would need to change for stateless scaling

To make extra instances safe without sticky sessions, the per-instance state
needs a shared store:

- Move the admin and owner replay caches to PostgreSQL or Redis, with a
  five-minute expiry.
- Give `@fastify/rate-limit` a shared store such as Redis.
- Optionally, run the log retention job and webhook worker in one process
  only, or behind an advisory lock like the indexer.

Until then, treat the per-instance rows above as known limits.

## See also

- [DEPLOYMENT.md](../DEPLOYMENT.md#running-more-than-one-instance) for the
  deployment checklist.
- [ARCHITECTURE.md](../ARCHITECTURE.md#process-boundaries-and-scaling) for
  how the API, indexer and workers fit together.
- [INDEXER.md](INDEXER.md) for checkpoints and recovery.
