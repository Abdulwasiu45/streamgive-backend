# Data retention

This page lists every table in `prisma/schema.prisma`, the personal data it
holds, and when its rows are deleted. It describes what the code does today.
If you add a model, a column that holds personal data, or a cleanup job,
update this page in the same change.

"Personal data" here means data that identifies or can be linked to a person
or organisation: email addresses, Stellar public keys, free text written by an
applicant or admin, and URLs they supply. A Stellar public key is a
pseudonymous identifier, but it is public on the ledger and links every
on-chain action by the same wallet, so it is listed.

## Summary

| Model (table)                                                           | What it holds                                                                      | Personal data                                                                                                                    | Deletion rule                                                                                                                                                                            |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Donor` (`donors`)                                                      | One row per donor wallet seen by the indexer.                                      | `address` (Stellar public key).                                                                                                  | Never deleted.                                                                                                                                                                           |
| `Ngo` (`ngos`)                                                          | NGOs registered on-chain, with verification state and the public profile.          | `ownerAddress`; `name`, `displayName`, `description`, `website`.                                                                 | Never deleted. A revoked NGO keeps its row with `verified = false`.                                                                                                                      |
| `Stream` (`streams`)                                                    | Donation streams from the donation-vault contract.                                 | Linked to a donor and an NGO; `createdTxHash` is public on-chain.                                                                | Never deleted. Cancelled streams keep their row with `status = CANCELLED`.                                                                                                               |
| `StreamEvent` (`stream_events`)                                         | Audit log of every contract event the indexer processed, with the full payload.    | `payload` contains the addresses and amounts from the event.                                                                     | Never deleted.                                                                                                                                                                           |
| `NgoApplication` (`ngo_applications`)                                   | Off-chain NGO applications and their review outcome.                               | `ownerAddress`, `name`, `description`, `website`, `contactEmail`, `country`; `reviewNote` and `reviewedBy` (admin address).      | Never deleted. Rejected and withdrawn applications keep their row with the final status.                                                                                                 |
| `NgoApplicationChallenge` (`ngo_application_challenges`)                | One-use sign-in challenges for submitting an application. Valid for 5 minutes.     | `ownerAddress`.                                                                                                                  | Deleted when used to submit an application. Expired rows are deleted each time anyone requests a new challenge (`POST /v1/ngo-applications/challenge`). No timer.                        |
| `NgoApplicationContactChallenge` (`ngo_application_contact_challenges`) | Pending contact-email verification token. Valid for 24 hours.                      | None directly. Stores only a SHA-256 hash of the token and the application id.                                                   | Deleted when the token is used, or when an expired token is presented. Replaced when a new verification email is sent. Deleted with its application (cascade). Otherwise kept.           |
| `IdempotencyRecord` (`idempotency_records`)                             | Stored responses for writes sent with an `Idempotency-Key`. Replayed for 24 hours. | `response` is the stored response body, which for `POST /v1/ngo-applications` is the full application, including `contactEmail`. | An expired row is deleted only when a request reuses the same key. Abandoned in-progress rows are deleted when the request fails. **No scheduled cleanup**: expired rows otherwise stay. |
| `NotificationLog` (`notification_logs`)                                 | One row per notification attempt per channel.                                      | None beyond event ids and error text.                                                                                            | Deleted daily when `createdAt` is older than `LOG_RETENTION_DAYS` (default 90).                                                                                                          |
| `NotificationEndpoint` (`notification_endpoints`)                       | Webhook destinations configured by admins.                                         | `url` of the receiver; `secret` (a credential, not personal data).                                                               | Deleted when an admin calls `DELETE /v1/admin/notification-endpoints/{id}`.                                                                                                              |
| `WebhookDelivery` (`webhook_deliveries`)                                | Durable webhook outbox: one row per event per destination, with retry state.       | `payload` is the event body (see below); `url` and `secret` are snapshots of the destination.                                    | **Never deleted.** Rows move to `SUCCEEDED` or `FAILED` and stay. Deleting an endpoint does not remove its deliveries.                                                                   |
| `IndexerCheckpoint` (`indexer_checkpoints`)                             | How far the indexer has read.                                                      | None.                                                                                                                            | Never deleted. One row per indexer id, updated in place.                                                                                                                                 |
| `IndexerDeadLetter` (`indexer_dead_letters`)                            | Contract events the indexer could not handle, with the raw XDR.                    | Raw `topic` and `value` may encode addresses; `resolvedBy` is an admin address.                                                  | Resolved rows are deleted daily once `resolvedAt` is older than `LOG_RETENTION_DAYS`. Unresolved rows are never deleted.                                                                 |

## Scheduled cleanup

There is one cleanup job: `pruneOldLogs` in
[`src/maintenance/logRetention.ts`](../src/maintenance/logRetention.ts).

- It runs once when the server is ready, then every 24 hours.
- It deletes `notification_logs` rows with `createdAt` before the cutoff, and
  `indexer_dead_letters` rows with `resolvedAt` before the cutoff.
- The cutoff is now minus `LOG_RETENTION_DAYS` days. The variable must be a
  positive integer; any other value falls back to 90. See
  [ENVIRONMENT.md](../ENVIRONMENT.md).
- It runs in every instance. The deletes are idempotent, so running it in
  several instances is safe but redundant.

No other table has a scheduled cleanup. The other deletions above happen as
part of a request.

## Notes by table

### Applications and contact email

`NgoApplication` is the only table that holds an email address. The address
is never returned by the public status endpoint, but it is returned to admins
and is copied into `idempotency_records.response` when the submission used an
`Idempotency-Key`. That copy has no scheduled cleanup, so removing an
application's email by hand also means checking `idempotency_records` for
keys with the `ngo-applications:` prefix.

The `application_submitted` webhook event carries the applicant's
`ownerAddress` and organisation `name`, and `application_reviewed` carries the
`reviewNote`. Neither carries the contact email.

### Webhook payloads

`webhook_deliveries.payload` stores the JSON event exactly as sent. The event
types and their fields are listed in
[`src/notifications/types.ts`](../src/notifications/types.ts) and
[NOTIFICATIONS.md](NOTIFICATIONS.md). They contain wallet addresses, ids,
amounts, application names and review notes. The row also keeps a snapshot of
the endpoint's `secret`, so deliveries can be retried after the endpoint is
edited or deleted.

### On-chain data

`Donor`, `Ngo`, `Stream` and `StreamEvent` mirror public ledger data. Deleting
a row does not remove anything from the ledger, and a backfill from an earlier
ledger writes the rows again. Deleting these rows by hand can also leave
`streams` and `stream_events` out of step, so treat them as append-only.

The NGO profile fields `displayName`, `description` and `website` are
off-chain. They are set by admins or by the NGO owner and are kept until
changed.

## Data outside the database

- **Process memory.** Admin and owner signature replay records (five
  minutes), rate-limit counters, recently delivered notification event ids
  (up to 10,000) and metrics counters. All of it is lost on restart. See
  [DEPLOYMENT.md](../DEPLOYMENT.md#running-more-than-one-instance).
- **Logs.** The server writes structured logs to standard output. They
  include request metadata such as the client IP used for rate limiting, and
  some warnings include signed payloads. Retention is set by the log
  collector of your hosting platform, not by this service.
- **Backups.** Rows deleted from the database stay in backups until those
  backups expire. See [BACKUP-RESTORE.md](BACKUP-RESTORE.md).

## Removing data by hand

There is no API to delete a donor, NGO, stream or application. To remove a
person's off-chain data, an operator has to edit the database directly:

1. Find their applications in `ngo_applications` by `owner_address` or
   `contact_email`.
2. Clear or redact `contact_email`, `description`, `website` and `country`, or
   delete the rows. Deleting an application also deletes its contact
   challenge.
3. Delete matching `idempotency_records` rows whose `response` contains the
   application.
4. Redact `webhook_deliveries.payload` rows that mention the application id or
   owner address, if required.
5. Clear the NGO's off-chain profile fields in `ngos` if they identify a
   person.

On-chain data such as addresses and stream amounts stays public on the
ledger whatever is done to the database.
