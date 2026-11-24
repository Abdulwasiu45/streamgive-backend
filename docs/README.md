# Documentation index

Guides and reference documents for the StreamGive backend are listed below.

## Project and operations

- [Project overview](../README.md) — Service overview, API links, and local development instructions.
- [Architecture overview](../ARCHITECTURE.md) — How the API, indexer, and notification dispatcher fit together.
- [Contributing guide](../CONTRIBUTING.md) — Local setup, code conventions, and contribution workflow.
- [Deployment guide](../DEPLOYMENT.md) — Production deployment, availability, and scaling guidance.
- [Environment variables](../ENVIRONMENT.md) — Runtime configuration, defaults, and validation rules.
- [Deployer hardening checklist](HARDENING.md) — Production checks for proxy trust, metrics, CORS, admin access, and rate limits.
- [Security policy](../SECURITY.md) — Vulnerability reporting and responsible disclosure.
- [Backup and restore](BACKUP-RESTORE.md) — PostgreSQL backup and recovery procedures.
- [Indexer guide](INDEXER.md) — Event polling, checkpoints, backfills, and recovery behavior.
- [Metrics reference](METRICS.md) — Prometheus metrics and monitoring guidance.
- [Production migrations](PRODUCTION-MIGRATIONS.md) — Applying database migrations safely in production.
- [Operations runbook](RUNBOOK.md) — Operational checks and responses to common incidents.
- [Testing guide](TESTING.md) — Test suites, local database setup, and test commands.

## API and data

- [API reference](API.md) — Endpoints, parameters, authentication, and response examples.
- [API versioning](API-VERSIONING.md) — API compatibility and versioning policy.
- [Data model](DATA-MODEL.md) — Database entities, relationships, and derived API statistics.
- [Admin request signing example](../src/scripts/signAdminRequest.ts) — TypeScript helper that prints a signed admin request as a `curl` command.
- [Notifications](NOTIFICATIONS.md) — Notification event types and delivery behavior.
- [Webhook receiver guide](WEBHOOKS.md) — Signature verification, retries, ordering, and idempotency for webhook consumers.
