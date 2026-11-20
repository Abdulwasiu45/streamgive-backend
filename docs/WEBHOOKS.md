# Receiving StreamGive webhooks

This guide is for the service on the other end of a webhook destination: the
receiver. It covers verifying that a request really came from StreamGive,
answering before the sender times out, and staying correct when the same event
arrives more than once.

For the payload shapes and the list of event types, see
[NOTIFICATIONS.md](./NOTIFICATIONS.md). For the operator-side view of a
destination (subscriptions, delivery logs, secrets), see the
[webhook destinations](./NOTIFICATIONS.md#webhook-destinations) section there.

## What a delivery looks like

- A `POST` with `content-type: application/json` and a JSON object body whose
  `type` field discriminates the event.
- An `x-streamgive-delivery-id` UUID and `x-streamgive-timestamp` Unix epoch
  seconds value on every request.
- When a destination secret is configured, an
  `x-streamgive-signature` header in the form `v1=<lower-case-hex>`. The
  digest signs the timestamp, delivery id, and **raw request body**. The
  signature header is absent only when the destination has no secret.
- Some events carry an `eventId` (the on-chain event id, e.g.
  `0000123450-0000000001`). API-originated events such as
  `application_submitted` do not have one.

The sender waits `NOTIFY_WEBHOOK_TIMEOUT_MS` (default 3000 ms) for the
response. A `2xx` response records success; anything else, a timeout, or a
connection error records a failure. There is no automatic retry loop, but
deliveries are **at-least-once**: an event can be delivered again when an
indexer event is reprocessed or a dead letter is replayed, and the same event
can reach several destinations independently.

## Verify the signature before parsing the body

Verify against the exact bytes received, not a re-serialised object: JSON key
order and whitespace are not guaranteed to survive a parse/stringify round
trip, and the HMAC is over the raw bytes.

### Node.js (Express)

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

const app = express();

// Keep the raw body around for the HMAC.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

function isFromStreamGive(rawBody, signatureHeader, timestamp, deliveryId, secret) {
  if (!signatureHeader || rawBody === undefined || !timestamp || !deliveryId) return false;
  const match = /^v1=([0-9a-f]{64})$/.exec(signatureHeader);
  const seconds = Number(timestamp);
  if (
    !match ||
    !Number.isSafeInteger(seconds) ||
    Math.abs(Date.now() / 1000 - seconds) > 300
  ) {
    return false;
  }

  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${deliveryId}.`)
    .update(rawBody)
    .digest();
  const received = Buffer.from(match[1], 'hex');

  // timingSafeEqual throws on a length mismatch, so check that first.
  return received.length === expected.length && timingSafeEqual(received, expected);
}

app.post('/hooks/streamgive', (req, res) => {
  if (
    !isFromStreamGive(
      req.rawBody,
      req.get('x-streamgive-signature'),
      req.get('x-streamgive-timestamp'),
      req.get('x-streamgive-delivery-id'),
      process.env.STREAMGIVE_WEBHOOK_SECRET,
    )
  ) {
    return res.status(401).send('invalid signature');
  }

  // Acknowledge immediately; do the work after the response is on its way.
  res.status(200).send('ok');
  queue.push(req.body);
});
```

### Python (Flask)

```python
import hashlib
import hmac
import time

from flask import Flask, request, abort

app = Flask(__name__)

@app.post("/hooks/streamgive")
def streamgive_hook():
    raw = request.get_data()  # bytes, exactly as received
    header = request.headers.get("x-streamgive-signature", "")
    timestamp = request.headers.get("x-streamgive-timestamp", "")
    delivery_id = request.headers.get("x-streamgive-delivery-id", "")
    try:
        seconds = int(timestamp)
    except ValueError:
        abort(401)
    if abs(time.time() - seconds) > 300 or not delivery_id:
        abort(401)
    signed = f"{timestamp}.{delivery_id}.".encode() + raw
    expected = "v1=" + hmac.new(SECRET.encode(), signed, hashlib.sha256).hexdigest()

    if not hmac.compare_digest(expected, header):
        abort(401)

    event = request.get_json()
    # Hand off to a worker; respond fast.
    return "", 200
```

Reject unsigned requests once a secret is configured. When a destination has no
secret, the header is omitted, so you cannot distinguish StreamGive from anyone
who learns the URL — treat that as a migration state, not a resting state.
Reject timestamps more than five minutes from the receiver's clock. Cache each
accepted `x-streamgive-delivery-id` for at least five minutes and reject a
duplicate ID to prevent replays within the timestamp window. Rotate the secret
by updating the destination, deploying the same value to the receiver, and only
then removing the old one.

## Answer quickly

Do the minimum inside the request: verify, persist or enqueue, return `2xx`.
Long work (sending email, calling another API, recomputing aggregates) belongs
in a queue or worker. A receiver that takes longer than the timeout is recorded
as a failed delivery even if it eventually finishes, and retrying the work is
then your problem.

Return `2xx` only after the event is durably accepted. A `5xx` or a dropped
connection tells StreamGive the delivery failed, which is accurate if you could
not persist it; returning `200` and then losing the body silently is not.

## Make handling idempotent

Assume at-least-once delivery. Keep a record of an event before applying its
effects, keyed by:

- `eventId` when the payload has one — this is the on-chain dedupe key; or
- for API-originated events without one, the natural key of the effect, such as
  `application_submitted:<applicationId>` and
  `application_reviewed:<applicationId>:<status>`.

Store that key in a table with a unique constraint and apply the change in the
same transaction, or check-and-insert before processing. A duplicate delivery
then becomes a no-op instead of a second email, a second ledger entry, or a
double-counted total.

Two further sources of duplicate-looking work:

- **Concurrent endpoints.** Each destination is called independently and
  concurrently, so the same event can arrive at two of your URLs at once.
  Deduplicate per destination _and_ globally on the effect you apply.
- **Out-of-order delivery.** Notifications are dispatched asynchronously after
  the database write, so `stream_withdrawn` can arrive before `stream_created`
  for the same stream if the first delivery was slow. Apply events as
  observations of new state where practical, or buffer them until the stream
  exists, rather than assuming creation always arrives first.

## Testing an endpoint

After adding or editing a receiver, an admin can send it a test event with
`POST /v1/admin/notification-endpoints/{id}/test`. The receiver gets a normal
signed request whose body is `{"type":"ping","endpointId":"...","sentAt":"..."}`
and whose delivery id starts with `ping-`. The response reports
`{ ok, statusCode, latencyMs, deliveryId, error? }`. A ping uses the normal
delivery timeout, is never retried, and is not recorded as a delivery.

## Inspecting failures

Delivery results are recorded on the StreamGive side, not retried against your
endpoint:

```sql
SELECT event_id, channel, success, error, created_at
FROM notification_logs
ORDER BY created_at DESC
LIMIT 50;
```

`channel` is `webhook:<endpoint-id>` for a configured destination, so one
destination's failures are separable from another's. A failed row stays failed;
if you need the event again, it has to come from a replay or a reprocessed
indexer event, which is why idempotency is mandatory rather than defensive.
