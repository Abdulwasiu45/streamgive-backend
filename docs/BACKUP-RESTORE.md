# PostgreSQL backup and restore

Back up the entire production database, including Prisma migration history,
indexer checkpoints, stored events, NGO applications and display overrides,
and notification configuration and delivery state. On-chain history alone
cannot recreate the off-chain records. Keep encrypted backups with restricted
access, take a snapshot at least daily and before migrations, and enable
point-in-time recovery where available. Test restoration regularly with an
isolated database.

```sh
pg_dump --format=custom --file=streamgive.dump "$SOURCE_DATABASE_URL"
pg_restore --exit-on-error --single-transaction --no-owner --dbname="$RESTORE_DATABASE_URL" streamgive.dump
```

Restore into a fresh database with compatible PostgreSQL extensions. Pause
writers, indexer workers, and delivery workers before cutting over. Verify
schema migration history, record counts, off-chain configurations, and
`/health` on the restored instance. Keep outbound notifications disabled
until pending delivery records are reconciled against deliveries made after
the backup.

Restart the indexer with the matching contract and network configuration.
It resumes from the restored checkpoint and should catch up to the current
ledger. Monitor checkpoint and lag, and inspect dead letters before reopening
traffic. If stored stream events exist but derived rows are missing, run
`npm run streams:rebuild -- --dry-run` first, then apply the rebuild after
reviewing the report. If the checkpoint predates RPC retention, use a
verified newer restore point or a supported historical replay source.
