# Indexer operations runbook

Use this when the indexer is behind, has skipped a ledger range, or has filled
the dead-letter table. It assumes the layout and behaviour described in
[INDEXER.md](./INDEXER.md).

## Signals to check first

| Signal                                                                                    | Where          | What it means                                                                                                                                                                                                 |
| ----------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health/ready`                                                                       | API            | `503 {"reason":"indexer_lagging","lag":N,"threshold":M}` when the checkpoint trails the RPC tip by more than `INDEXER_LAG_THRESHOLD` (default 100). `indexer_not_started` means no checkpoint row exists yet. |
| `GET /v1/indexer/status`                                                                  | API            | `{ configured, checkpointLedger, updatedAt, latestLedger, ledgerLag }`. `updatedAt` is when the checkpoint last moved.                                                                                        |
| `streamgive_indexer_lag_ledgers`                                                          | `GET /metrics` | Same lag as a gauge.                                                                                                                                                                                          |
| `streamgive_indexer_events_dead_lettered_total`                                           | `GET /metrics` | Non-zero means events were skipped and recorded for replay.                                                                                                                                                   |
| `streamgive_indexer_events_skipped_total`                                                 | `GET /metrics` | Non-zero means the checkpoint aged out of the RPC retention window and was moved forward; the gap is not recoverable from RPC.                                                                                |
| `indexer poll failed (N in a row) — retrying in Xms`                                      | logs           | Transient RPC/DB failure; the worker backs off and retries.                                                                                                                                                   |
| `indexer: checkpoint N has aged out of the RPC's retention window — skipping to ledger M` | logs           | Permanent gap. Go to [skip-ahead recovery](#skip-ahead-recovery).                                                                                                                                             |
| `recording it as a dead letter and skipping it`                                           | logs           | One event could not be decoded or validated. Go to [dead letters](#dead-letters).                                                                                                                             |

A healthy indexer polls every `INDEXER_POLL_INTERVAL_MS` (default 5 s). A
single failed poll retries at the same interval; consecutive failures double
the delay up to 5 minutes, and the first success resets it. Lag that shrinks
without operator action is normal catch-up: a `getEvents` poll can return a
batch spanning many ledgers, and each event moves the checkpoint individually.

## Lag

1. Check the RPC endpoint directly (`getHealth` on `SOROBAN_RPC_URL`). If it is
   down or erroring, the indexer is doing the right thing by backing off; wait
   or point at a healthy endpoint.
2. Check the log stream for `indexer poll failed`. A repeated database error
   (connection, timeout, deadlock) is a database problem, not an indexer one;
   fix the database and the checkpoint resumes from where it stopped.
3. If `ledgerLag` is large but the log shows no failures and `updatedAt` keeps
   moving, the indexer is catching up. Watch the gauge fall.
4. Only restart the process if the lag is static while the RPC is healthy and
   no poll failures are logged. A restart resumes from the saved checkpoint;
   it does not replay anything.
5. If the lag crossed into the retention window, the next poll logs the
   skip-ahead warning. Follow the next section instead of waiting.

## Skip-ahead recovery

The RPC serves only a sliding retention window (`ledgerRetentionWindow` from
`getHealth`: roughly a day on public Mainnet, about a week on public Testnet).
When the saved checkpoint is older than that, the indexer logs:

```
indexer: checkpoint <N> has aged out of the RPC's retention window —
skipping to ledger <M>. Events in between were missed and will not be indexed.
```

and saves `M` as the new checkpoint. Restarting does not undo this.

1. Record the gap: `<N>` (last good ledger) to `<M>` (new checkpoint). Put it
   in the incident notes; the log line is the only place it exists.
2. Confirm the projection damage. Missing events can mean stale NGO
   `verified` flags, missing streams, or missing withdrawals/cancellations.
   - For NGO verification flags, run the reconciliation script:
     `npx tsx src/scripts/reconcileVerification.ts` (add `--fix` to apply).
   - For stream and NGO rows, query the affected range against an archive
     endpoint or an indexer that retained it; the database cannot tell you what
     it never saw.
3. Recover the gap with a purpose-built backfill from an archive RPC. Do
   **not** simply move the checkpoint backward: handlers apply relative deltas
   (`balance -= accrued`), so replaying events that were already applied
   double-counts them. The backfill tooling is tracked in
   [issue #11](https://github.com/StreamGive/streamgive-backend/issues/11).
4. After backfilling, re-run the reconciliation script and check
   `streamgive_indexer_events_skipped_total` no longer increases.
5. Treat the incident as data loss until step 3 is complete. The indexer is
   healthy again immediately after the skip; the projections are not.

## Dead letters

A dead letter is an event the indexer could not process because its payload
did not match what the handler expects (decode/validation error). The worker
records it, advances the checkpoint past it, and continues — so one bad event
costs that event, not the stream of events behind it. Transient failures
(RPC, database, timeouts) are **not** dead-lettered; the checkpoint stays put
and the event is retried with backoff.

### Inspect

SQL:

```sql
SELECT event_id, ledger, contract_id, error, attempts, resolved_at
FROM indexer_dead_letters
WHERE resolved_at IS NULL
ORDER BY ledger;
```

Or the admin API (requires the admin signature headers — see
[API.md](./API.md#get-v1admindead-letters)):

```bash
curl "$API_PUBLIC_URL/v1/admin/dead-letters?resolved=false&limit=100"
```

### Diagnose

- `attempts` above 1 means the event has failed again on replay, or a replay
  handler recorded a new failure instead of throwing.
- The `error` text names the shape mismatch (`Cannot read properties of
undefined`, `Unknown stream`, an XDR/StrKey decode error). Compare `topic`
  and `value` (base64 XDR) with the decoding assumptions in
  [INDEXER.md](./INDEXER.md#soroban-event-decoding-assumptions). A mismatch
  usually means the contract emitted a new shape before the handler was
  updated.
- If the event belongs to a contract that is no longer in
  `WATCHED_CONTRACT_IDS`, replay refuses it on purpose (it would be a silent
  no-op otherwise). Re-add the contract ID before replaying, or resolve the row
  manually knowing the effect will not be applied.

### Resolve without replay

If the underlying cause was fixed manually and the event should not be replayed,
use the admin API to close the row and preserve an audit trail:

```http
POST /v1/admin/dead-letters/<uuid>/resolve
Content-Type: application/json

{"note":"Cause corrected manually; replay not required"}
```

The request requires the normal admin signature. The response records the
admin address and resolution time. A `409` means the row has already been
resolved. Prefer this endpoint to direct SQL; the SQL update below is for
break-glass recovery only.

### Replay

```bash
npm run deadletters:replay
```

The script re-runs every unresolved row oldest-first, one at a time, through
the normal dispatcher. A row is marked resolved only when the handler returns
without recording a new failure; failures keep the row open and update its
error and attempt count. The process exits non-zero if any row still fails.

Before replaying:

- Fix the handler or contract-shape assumption first. Replaying an event into
  the same failing code just increments `attempts`.
- Expect duplicate webhooks. Replay re-runs the handler, which re-emits the
  notification. Successful deliveries for the same `eventId` and destination
  are skipped using `notification_logs`, but a destination that previously
  failed will be called again. Receivers must be idempotent; see
  [WEBHOOKS.md](./WEBHOOKS.md).
- Do not run two replays at once, and do not replay while a full reindex is
  running. The handlers apply relative balance changes; out-of-order application
  corrupts stream balances.

To close a row without replaying (accepting that its effect is lost):

```sql
UPDATE indexer_dead_letters
SET resolved_at = now()
WHERE event_id = '<event id>';
```

Record why in the incident notes. This is appropriate only when the event is
known to be irrelevant (for example, a duplicate of another event).

## Full reindex or backfill

The indexer has no built-in "reindex" mode. A reindex means starting the
projection from a clean state and replaying chain history from a ledger the RPC
can still serve (an archive endpoint if the target range is outside the public
retention window).

1. **Back up.** Snapshot the database before touching projections. A reindex
   that goes wrong is not reversible from the chain alone if you also lose
   `ngo_applications` or `notification_endpoints` data.
2. **Choose the start ledger.** `INDEXER_START_LEDGER` is honoured only when no
   checkpoint row exists; an existing checkpoint always wins.
3. **Decide where to replay into.** The safe option is a fresh database:
   create it, run `npm run db:deploy`, point `DATABASE_URL` at it, and let the
   indexer rebuild `donors`, `ngos`, `streams`, and `stream_events`. Then move
   the API and indexer over together. Reindexing in place means truncating
   `stream_events`, `streams`, `donors`, and `ngos` and deleting the checkpoint;
   any API-only rows in those tables that you did not recreate are lost, and
   the live API serves an empty projection until catch-up finishes.
4. **Reset the checkpoint last.** In place:

   ```sql
   TRUNCATE stream_events, streams, donors, ngos CASCADE;
   DELETE FROM indexer_checkpoints;
   ```

   `indexer_dead_letters` is deliberately not truncated: unresolved rows are
   recovery data. Resolve or replay them separately.

5. **Restart with the start ledger set.** For example
   `INDEXER_START_LEDGER=<ledger> npm start`. The first poll writes the
   checkpoint and returns; the next poll begins indexing from there.
6. **Watch progress** with `GET /v1/indexer/status` and
   `streamgive_indexer_events_processed_total`. Keep `INDEXER_MAX_EVENTS_PER_POLL`
   at a value the RPC tolerates; large backfills are faster with more polls,
   not bigger ones.
7. **Reconcile and verify.** Run `npx tsx src/scripts/reconcileVerification.ts`
   (then `--fix` if needed), confirm `/health/ready` is `200`, and check the
   dead-letter count is not growing.
8. **Expect notification duplicates** for any event whose delivery log was
   wiped with the database. Receivers deduplicate on `eventId`; see
   [WEBHOOKS.md](./WEBHOOKS.md).

## Escalation checklist

- Gap recorded: last good ledger, skip target, timestamp.
- RPC health and retention window captured.
- Reconciliation run, with or without `--fix`.
- Unresolved dead letters reviewed; replay result recorded.
- `/health/ready` and `/v1/indexer/status` values after recovery.
- Known projection gaps and the backfill ticket/PR that will close them.
