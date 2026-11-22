# Notification events

The backend POSTs a JSON body to each configured webhook destination for every
notification it emits (see [Webhook destinations](#webhook-destinations)).
Every body is discriminated by its `type` field. The matching TypeScript definitions live in
[`src/notifications/types.ts`](../src/notifications/types.ts).

All events may include an optional `eventId` — the on-chain event id used to
deduplicate deliveries and to retry failed sends. Each webhook request also
includes an `x-streamgive-delivery-id` and an epoch-seconds
`x-streamgive-timestamp`. When a destination secret is configured, the
`x-streamgive-signature` header contains a versioned HMAC over the timestamp,
delivery id, and exact request body. See [signature verification](#signature-verification)
below.

For receiver-side guidance — signature verification, answering within the
timeout, retries, ordering and idempotency — see
[WEBHOOKS.md](./WEBHOOKS.md).

## `ngo_registered`

Emitted when an NGO signs up through the `register` entry point of the
`ngo-registry` contract.

```json
{
  "type": "ngo_registered",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3...",
  "eventId": "0000000100-0000000000"
}
```

- `ownerAddress` — the NGO owner's Stellar account address.
- `ngoId` — the internal (database) id of the newly registered NGO.
- `eventId` — optional; the on-chain event id for this registration.

## `ngo_approved`

Emitted when an admin approves a registered NGO.

```json
{
  "type": "ngo_approved",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3...",
  "eventId": "0000000100-0000000000"
}
```

## `ngo_revoked`

Emitted when an admin revokes a verified NGO.

```json
{
  "type": "ngo_revoked",
  "ownerAddress": "GABC...",
  "ngoId": "clx1y2z3...",
  "eventId": "0000000100-0000000000"
}
```

## `stream_created`

Emitted when a donor opens a new donation stream to an NGO.

```json
{
  "type": "stream_created",
  "streamId": "1234",
  "donorAddress": "GABC...",
  "ngoId": "clx1y2z3...",
  "eventId": "0000000100-0000000000"
}
```

## `stream_withdrawn`

Emitted when accrued funds are withdrawn to the NGO from an active stream.

```json
{
  "type": "stream_withdrawn",
  "streamId": "1234",
  "amount": "500000000",
  "eventId": "0000000100-0000000000"
}
```

- `amount` — the amount withdrawn, in the stream token's base units, as a
  string.

## `stream_cancelled`

Emitted when a stream is cancelled, settling accrued funds to the NGO and
refunding the remaining balance to the donor.

```json
{
  "type": "stream_cancelled",
  "streamId": "1234",
  "settledToNgo": "500000000",
  "refundToDonor": "1500000000",
  "eventId": "0000000100-0000000000"
}
```

## `application_submitted`

Emitted when an NGO application is submitted through the API.

```json
{
  "type": "application_submitted",
  "applicationId": "clx1y2z3...",
  "ownerAddress": "GABC...",
  "name": "Red Cross",
  "eventId": "0000000100-0000000000"
}
```

## `application_reviewed`

Emitted when an admin approves or rejects an NGO application.

```json
{
  "type": "application_reviewed",
  "applicationId": "clx1y2z3...",
  "ownerAddress": "GABC...",
  "status": "APPROVED",
  "reviewNote": "Verified against public records.",
  "eventId": "0000000100-0000000000"
}
```

- `status` — either `APPROVED` or `REJECTED`.
- `reviewNote` — optional admin review note.

## Delivery headers and timeout

Each webhook delivery is an HTTP `POST` with these headers:

| Header                     | Value                                                                           |
| -------------------------- | ------------------------------------------------------------------------------- |
| `content-type`             | `application/json`                                                              |
| `x-streamgive-delivery-id` | Stable UUID for the persisted delivery; unchanged on retries.                   |
| `x-streamgive-timestamp`   | Unix epoch time in seconds, refreshed for each attempt.                         |
| `x-streamgive-signature`   | `v1=<lower-case-hex>` HMAC-SHA256, sent only when the destination has a secret. |

The sender waits up to 3 seconds by default. Set `NOTIFY_WEBHOOK_TIMEOUT_MS`
to a positive integer number of milliseconds to change the limit. A timeout is
a failed attempt and is retried with exponential backoff, up to five attempts.
Respond with a 2xx status to acknowledge a delivery.

## Webhook destinations

`notification_endpoints` stores one destination per row: `url`, `secret`,
`event_types`, and `enabled`. Event types use the names in
`src/notifications/types.ts` (for example `stream_created` and
`application_submitted`). A notification is sent only to enabled endpoints
whose event list contains its type. Destinations are called concurrently.

Every delivery is first persisted in `webhook_deliveries`, then recorded in
`notification_logs`. Configured endpoints use a channel value of
`webhook:<endpoint-id>`, so a success or failure can be inspected independently
for each destination. Failed deliveries retry with exponential backoff and
stop after five attempts. A delivery keeps its original URL and secret
snapshot so retries survive endpoint edits and deletion. The API never returns
stored endpoint secrets. Logs do not include endpoint secrets or URL paths.

The existing `NOTIFY_WEBHOOK_URL` and `NOTIFY_WEBHOOK_SECRET` variables remain
available for migration: they are used as a single all-events destination
only while there are no enabled rows in the table. Once an endpoint is
enabled, table subscriptions take precedence.

Endpoint configuration is operational data. Restrict database access to
trusted operators and use HTTPS URLs for destinations.

Signed administrators manage endpoints through `GET` and `POST
/v1/admin/notification-endpoints`, plus `PATCH` and `DELETE
/v1/admin/notification-endpoints/{id}`. Creation and updates accept `url`,
`secret`, `eventTypes`, and (on update) `enabled`; the URL must use HTTPS and
must not resolve to a private or local address. The response omits `secret`,
including after creation, so keep the supplied secret in the operator's secret
manager.

## Signature verification

When a destination secret is configured, `x-streamgive-signature` has the
form `v1=<lower-case-hex>`. The digest is HMAC-SHA256 of the UTF-8 bytes of
`<timestamp>.<delivery-id>.<raw-request-body>`, keyed with the destination's
secret. Verify the raw body bytes before parsing JSON. The timestamp is Unix
epoch seconds; reject requests more than five minutes from the receiver's
current time. Cache accepted delivery IDs for at least that same five-minute
window and reject duplicates to prevent replay within the timestamp window.

The sender uses the persisted delivery UUID and a new timestamp for each HTTP
attempt, allowing receivers to deduplicate retries.
When no secret is configured, the ID and timestamp are still sent but the
signature header is omitted; receivers should require a signature after
configuring a secret.

For complete Node.js and Python receiver examples, including timestamp and
replay checks, see [WEBHOOKS.md](./WEBHOOKS.md).

Here is a minimal Node.js verification example. Pass the exact raw request
body bytes (before JSON parsing), the three `x-streamgive-*` headers, and the
secret configured for the destination:

```js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verifyNotification(rawBody, headers, secret) {
  const timestamp = headers['x-streamgive-timestamp'];
  const deliveryId = headers['x-streamgive-delivery-id'];
  const match = /^v1=([0-9a-f]{64})$/.exec(headers['x-streamgive-signature'] ?? '');
  const seconds = Number(timestamp);

  if (
    !match ||
    !timestamp ||
    !deliveryId ||
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

  return received.length === expected.length && timingSafeEqual(received, expected);
}
```
