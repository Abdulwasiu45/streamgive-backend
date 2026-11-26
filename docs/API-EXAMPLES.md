# API examples

Copy-ready `curl` commands for every public endpoint, each with a short sample
response. For parameters, error codes and full field lists, see the
[API reference](API.md). Admin and owner routes need signed headers and are
not listed here; see [Authentication](API.md#authentication) and
`src/scripts/signAdminRequest.ts`.

Set the base URL once:

```bash
export BASE=http://localhost:3000
```

The sample responses were captured from a local server loaded with
`npm run db:seed`, then shortened: long lists show one item. IDs, addresses
and timestamps will differ on your server. Replace them with values from your
own responses, for example an NGO `id` from `GET /v1/ngos`.

Amounts are decimal strings in the token's smallest unit. Parse them with
`BigInt`, not `Number`. See
[Integer and amount representation](API.md#integer-and-amount-representation).

Add `-i` to any command to see response headers such as `ETag`,
`Cache-Control` and `x-request-id`.

## Contents

- [Health, version and metrics](#health-version-and-metrics)
- [NGOs](#ngos)
- [Donors](#donors)
- [Streams](#streams)
- [Tokens](#tokens)
- [Impact](#impact)
- [Indexer](#indexer)
- [NGO applications](#ngo-applications)
- [Conditional requests](#conditional-requests)

## Health, version and metrics

These routes are mounted at the server root, not under `/v1`.

### `GET /health`

```bash
curl -s "$BASE/health"
```

```json
{ "status": "ok", "db": "ok" }
```

`GET /v1/health` returns the same response.

### `GET /health/ready`

```bash
curl -s "$BASE/health/ready"
```

```json
{ "status": "ok", "lag": 5, "latestLedger": 123455, "checkpointLedger": 123450 }
```

Before the indexer has saved a checkpoint, it returns `503`:

```json
{ "status": "error", "reason": "indexer_not_started" }
```

### `GET /version`

```bash
curl -s "$BASE/version"
```

```json
{ "version": "0.1.0", "commit": "unknown", "buildTime": null }
```

### `GET /metrics`

```bash
curl -s "$BASE/metrics"
```

When the server sets `METRICS_TOKEN`, send it as a bearer token:

```bash
curl -s "$BASE/metrics" -H "Authorization: Bearer $METRICS_TOKEN"
```

```text
# HELP streamgive_http_requests_total Total HTTP requests handled.
# TYPE streamgive_http_requests_total counter
streamgive_http_requests_total{method="GET",route="/health",status_code="200"} 1
```

### `GET /docs/json`

The generated OpenAPI document. The interactive version is at `$BASE/docs`.

```bash
curl -s "$BASE/docs/json"
```

```json
{
  "openapi": "3.0.3",
  "info": { "title": "StreamGive API", "version": "0.1.0" },
  "paths": { "...": {} }
}
```

## NGOs

### `GET /v1/ngos`

List verified NGOs. Optional: `limit`, `cursor`, `sort` (`newest`, `oldest`,
`name`) and `q` (name search).

```bash
curl -s "$BASE/v1/ngos?limit=2&sort=name&q=water"
```

```json
{
  "ngos": [
    {
      "id": "615297bf-55ff-48ef-a9fe-04ebde4ef80e",
      "ownerAddress": "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
      "name": "Clean Water Initiative",
      "displayName": null,
      "verified": true,
      "createdAt": "2026-11-25T12:19:44.567Z",
      "updatedAt": "2026-11-25T12:19:44.567Z"
    }
  ],
  "nextCursor": null
}
```

### `GET /v1/ngos/lookup`

Find an NGO by its owner's Stellar address, verified or not.

```bash
curl -s "$BASE/v1/ngos/lookup?address=GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR"
```

The response has the same shape as `GET /v1/ngos/{id}` below.

### `GET /v1/ngos/{id}`

```bash
curl -s "$BASE/v1/ngos/615297bf-55ff-48ef-a9fe-04ebde4ef80e"
```

```json
{
  "id": "615297bf-55ff-48ef-a9fe-04ebde4ef80e",
  "ownerAddress": "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
  "name": "Clean Water Initiative",
  "displayName": null,
  "verified": true,
  "verifiedAt": null,
  "description": "We bring clean drinking water to rural communities across Sub-Saharan Africa through bore-hole drilling and maintenance.",
  "website": "https://cleanwaterinitiative.example",
  "profileUpdatedAt": null,
  "createdAt": "2026-11-25T12:19:44.567Z",
  "updatedAt": "2026-11-25T12:19:44.567Z",
  "registered": true,
  "country": "Kenya",
  "stats": {
    "totalCommitted": "7750000000",
    "committedByToken": [
      {
        "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        "amount": "7750000000"
      }
    ],
    "totalWithdrawn": "750000000",
    "activeStreamCount": 2,
    "donorCount": 2
  },
  "recentStreams": [
    {
      "id": "aeb4ecbc-6619-403b-92f7-76fad603949f",
      "donor": { "address": "GBXHUHG5FGYLPD6RHL2MKWMP572O6KUXCZXDZJXS4T57ZTMAKBN7DWXN" },
      "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "rate": "50000000",
      "balance": "2000000000",
      "withdrawn": "250000000",
      "status": "ACTIVE",
      "createdAt": "2026-11-25T12:19:44.639Z",
      "onChainId": "2"
    }
  ],
  "recentStreamsNextCursor": null
}
```

### `GET /v1/ngos/{id}/donors`

Donors who stream to this NGO. Optional: `limit`, `cursor`.

```bash
curl -s "$BASE/v1/ngos/615297bf-55ff-48ef-a9fe-04ebde4ef80e/donors?limit=2"
```

```json
{
  "donors": [
    {
      "id": "82100e50-90a1-474e-a54b-10b97e006bbd",
      "address": "GBXHUHG5FGYLPD6RHL2MKWMP572O6KUXCZXDZJXS4T57ZTMAKBN7DWXN",
      "totalCommitted": "2250000000",
      "committedByToken": [
        {
          "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "amount": "2250000000"
        }
      ]
    }
  ],
  "nextCursor": null
}
```

## Donors

### `GET /v1/donors`

Donor leaderboard. Optional: `sort` (`committed`, `withdrawn`), `order`
(`desc`, `asc`), `limit`, `cursor`.

```bash
curl -s "$BASE/v1/donors?sort=committed&order=desc&limit=2"
```

```json
{
  "donors": [
    {
      "id": "82100e50-90a1-474e-a54b-10b97e006bbd",
      "address": "GBXHUHG5FGYLPD6RHL2MKWMP572O6KUXCZXDZJXS4T57ZTMAKBN7DWXN",
      "createdAt": "2026-11-25T12:19:44.629Z",
      "totalCommitted": "11050000000",
      "committedByToken": [
        {
          "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "amount": "11050000000"
        }
      ],
      "totalWithdrawn": "1050000000"
    }
  ],
  "nextCursor": null
}
```

### `GET /v1/donors/{address}`

```bash
curl -s "$BASE/v1/donors/GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP"
```

```json
{
  "id": "e7e60b6e-b52c-4895-aa69-27a034b88874",
  "address": "GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP",
  "createdAt": "2026-11-25T12:19:44.625Z",
  "totalCommitted": "6500000000",
  "committedByToken": [
    {
      "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "amount": "6500000000"
    }
  ],
  "totalWithdrawn": "1500000000",
  "activeStreamCount": 1,
  "distinctNgoCount": 2
}
```

### `GET /v1/donors/{address}/ngos`

The NGOs a donor supports, with totals per token.

```bash
curl -s "$BASE/v1/donors/GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP/ngos"
```

```json
{
  "ngos": [
    {
      "ngoId": "615297bf-55ff-48ef-a9fe-04ebde4ef80e",
      "name": "Clean Water Initiative",
      "displayName": null,
      "ownerAddress": "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
      "verified": true,
      "streamCount": 1,
      "activeStreamCount": 1,
      "totalsByToken": [
        {
          "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
          "committed": "5500000000",
          "withdrawn": "500000000"
        }
      ]
    }
  ]
}
```

### `GET /v1/donors/{address}/streams.csv`

Every stream for a donor as CSV. Save it with `-o`:

```bash
curl -s "$BASE/v1/donors/GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP/streams.csv" -o streams.csv
```

```text
id,onChainId,ngoId,ngoName,ngoAddress,tokenAddress,rate,lastRate,balance,withdrawn,status,createdTxHash,createdAt,updatedAt
04b42eba-7fec-44ef-9be9-4cc62bee3b3f,1,615297bf-55ff-48ef-a9fe-04ebde4ef80e,Clean Water Initiative,GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR,CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA,100000000,,5000000000,500000000,ACTIVE,,2026-11-25T12:19:44.634Z,2026-11-25T12:19:44.634Z
```

## Streams

### `GET /v1/streams`

Newest first. Optional filters: `donor`, `ngo` (NGO UUID), `ngoAddress`,
`token`, `status` (`ACTIVE`, `CANCELLED`), `createdAfter`, `createdBefore`
(ISO 8601), plus `limit` and `cursor`.

```bash
curl -s "$BASE/v1/streams?status=ACTIVE&limit=1"
```

```json
{
  "streams": [
    {
      "id": "ece9b7e7-b23c-4fed-87c1-38fe8c57a79f",
      "donorId": "82100e50-90a1-474e-a54b-10b97e006bbd",
      "ngoId": "49273d65-ba16-45f2-9fba-98b0fb8dddcd",
      "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "rate": "200000000",
      "lastRate": null,
      "balance": "8000000000",
      "withdrawn": "800000000",
      "status": "ACTIVE",
      "createdTxHash": null,
      "createdAt": "2026-11-25T12:19:44.645Z",
      "updatedAt": "2026-11-25T12:19:44.645Z",
      "donor": { "address": "GBXHUHG5FGYLPD6RHL2MKWMP572O6KUXCZXDZJXS4T57ZTMAKBN7DWXN" },
      "onChainId": "4",
      "ngo": {
        "id": "49273d65-ba16-45f2-9fba-98b0fb8dddcd",
        "name": "Education For All",
        "displayName": null,
        "ownerAddress": "GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U",
        "registered": true
      }
    }
  ],
  "hasMore": true,
  "nextCursor": "ece9b7e7-b23c-4fed-87c1-38fe8c57a79f"
}
```

Fetch the next page by passing `nextCursor` back with the same filters:

```bash
curl -s "$BASE/v1/streams?status=ACTIVE&limit=1&cursor=ece9b7e7-b23c-4fed-87c1-38fe8c57a79f"
```

### `GET /v1/streams/{id}`

```bash
curl -s "$BASE/v1/streams/04b42eba-7fec-44ef-9be9-4cc62bee3b3f"
```

```json
{
  "id": "04b42eba-7fec-44ef-9be9-4cc62bee3b3f",
  "donorId": "e7e60b6e-b52c-4895-aa69-27a034b88874",
  "ngoId": "615297bf-55ff-48ef-a9fe-04ebde4ef80e",
  "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
  "rate": "100000000",
  "lastRate": null,
  "balance": "5000000000",
  "withdrawn": "500000000",
  "status": "ACTIVE",
  "createdTxHash": null,
  "createdAt": "2026-11-25T12:19:44.634Z",
  "updatedAt": "2026-11-25T12:19:44.634Z",
  "donor": { "address": "GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP" },
  "onChainId": "1",
  "ngo": {
    "id": "615297bf-55ff-48ef-a9fe-04ebde4ef80e",
    "name": "Clean Water Initiative",
    "displayName": null,
    "ownerAddress": "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
    "registered": true
  }
}
```

### `GET /v1/streams/on-chain/{onChainId}`

Look up a stream by the id the donation-vault contract assigned.

```bash
curl -s "$BASE/v1/streams/on-chain/1"
```

The response is the same as `GET /v1/streams/{id}`.

### `GET /v1/streams/{id}/activity`

Indexed contract events for one stream, newest first. Optional: `limit`,
`cursor`.

```bash
curl -s "$BASE/v1/streams/04b42eba-7fec-44ef-9be9-4cc62bee3b3f/activity?limit=10"
```

```json
{
  "events": [
    {
      "id": "8d1f6c0e-3b2a-4f5e-9c7d-1a2b3c4d5e6f",
      "type": "created",
      "streamId": "1",
      "ledger": 123450,
      "txHash": "<TRANSACTION_HASH>",
      "payload": {
        "donor": "GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP",
        "ngo": "GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR",
        "token": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
        "deposit": "5000000000",
        "rate": "100000000"
      },
      "createdAt": "2026-11-25T12:19:44.634Z"
    }
  ],
  "hasMore": false,
  "nextCursor": null
}
```

The seed data has no events, so a freshly seeded server returns
`"events": []`.

## Tokens

### `GET /v1/tokens`

Token contracts that have at least one stream.

```bash
curl -s "$BASE/v1/tokens"
```

```json
{
  "tokens": [
    { "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA", "streamCount": 4 }
  ]
}
```

## Impact

### `GET /v1/impact`

Platform-wide totals.

```bash
curl -s "$BASE/v1/impact"
```

```json
{
  "totalCommitted": "17550000000",
  "committedByToken": [
    {
      "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "amount": "17550000000"
    }
  ],
  "totalWithdrawn": "2550000000",
  "activeStreams": 3,
  "verifiedNgoCount": 2
}
```

### `GET /v1/impact/{ngoId}`

```bash
curl -s "$BASE/v1/impact/615297bf-55ff-48ef-a9fe-04ebde4ef80e"
```

```json
{
  "ngoId": "615297bf-55ff-48ef-a9fe-04ebde4ef80e",
  "name": "Clean Water Initiative",
  "totalCommitted": "7750000000",
  "committedByToken": [
    {
      "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "amount": "7750000000"
    }
  ],
  "platformCommittedByToken": [
    {
      "tokenAddress": "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      "amount": "17550000000"
    }
  ],
  "totalWithdrawn": "750000000",
  "activeStreams": 2,
  "cancelledStreams": 0,
  "uniqueDonors": 2,
  "platformSharePercent": 44.159544159544
}
```

### `GET /v1/impact/{ngoId}/timeseries`

Daily activity for one NGO. Optional: `from` and `to` (`YYYY-MM-DD`).

```bash
curl -s "$BASE/v1/impact/615297bf-55ff-48ef-a9fe-04ebde4ef80e/timeseries?from=2026-11-01&to=2026-11-02"
```

```json
{
  "ngoId": "615297bf-55ff-48ef-a9fe-04ebde4ef80e",
  "from": "2026-11-01",
  "to": "2026-11-02",
  "days": [
    { "date": "2026-11-01", "newStreams": 0, "withdrawals": 0, "withdrawnAmount": "0" },
    { "date": "2026-11-02", "newStreams": 0, "withdrawals": 0, "withdrawnAmount": "0" }
  ]
}
```

## Indexer

### `GET /v1/indexer/status`

```bash
curl -s "$BASE/v1/indexer/status"
```

```json
{
  "configured": true,
  "checkpointLedger": 123450,
  "updatedAt": "2026-11-25T12:19:44.634Z",
  "latestLedger": 123455,
  "ledgerLag": 5
}
```

With no contracts configured, `configured` is `false` and the ledger fields
are `null`.

## NGO applications

Submitting an application takes two requests: get a challenge, sign its
`message` with the applicant's wallet (SEP-53 message signing), then submit.

### `POST /v1/ngo-applications/challenge`

```bash
curl -s -X POST "$BASE/v1/ngo-applications/challenge" \
  -H 'content-type: application/json' \
  -d '{"ownerAddress":"GDULJMXHZUJKYY5B43SZFRTFCHP6YBPEITFVTVYOS2W56MAVQE4CWQ3S"}'
```

```json
{
  "challenge": "1e56ea50-94b7-4c83-9bd5-3773d6c70de3",
  "message": "StreamGive NGO application address verification\nOwner address: GDULJMXHZUJKYY5B43SZFRTFCHP6YBPEITFVTVYOS2W56MAVQE4CWQ3S\nChallenge: 1e56ea50-94b7-4c83-9bd5-3773d6c70de3\nExpires at: 2026-11-25T12:25:31.836Z",
  "expiresAt": "2026-11-25T12:25:31.836Z"
}
```

The challenge expires after five minutes and can be used once.

### `POST /v1/ngo-applications`

Replace `<SIGNATURE>` with the base64 or hex signature of the challenge
`message`. The optional `Idempotency-Key` header makes retries safe.

```bash
curl -s -X POST "$BASE/v1/ngo-applications" \
  -H 'content-type: application/json' \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "ownerAddress": "GDULJMXHZUJKYY5B43SZFRTFCHP6YBPEITFVTVYOS2W56MAVQE4CWQ3S",
    "name": "Example Aid",
    "description": "Supporting local communities.",
    "contactEmail": "contact@example.org",
    "website": "example.org",
    "country": "Kenya",
    "challenge": "1e56ea50-94b7-4c83-9bd5-3773d6c70de3",
    "signature": "<SIGNATURE>"
  }'
```

`201 Created`:

```json
{
  "id": "42e44fa3-cf3e-496b-bb5b-75b07c85410f",
  "ownerAddress": "GDULJMXHZUJKYY5B43SZFRTFCHP6YBPEITFVTVYOS2W56MAVQE4CWQ3S",
  "name": "Example Aid",
  "description": "Supporting local communities.",
  "website": "https://example.org",
  "contactEmail": "contact@example.org",
  "country": "Kenya",
  "status": "PENDING",
  "reviewNote": null,
  "reviewedBy": null,
  "reviewedAt": null,
  "emailVerifiedAt": null,
  "lastContactVerificationSentAt": null,
  "createdAt": "2026-11-25T12:20:31.856Z",
  "updatedAt": "2026-11-25T12:20:31.856Z"
}
```

### `GET /v1/ngo-applications/status`

The latest application's status for an owner address. Contact details are
not returned.

```bash
curl -s "$BASE/v1/ngo-applications/status?ownerAddress=GDULJMXHZUJKYY5B43SZFRTFCHP6YBPEITFVTVYOS2W56MAVQE4CWQ3S"
```

```json
{
  "status": "PENDING",
  "createdAt": "2026-11-25T12:20:31.856Z",
  "updatedAt": "2026-11-25T12:20:31.856Z"
}
```

### `GET /v1/ngo-applications/verify-contact-email`

The link sent in the verification email. It returns a small HTML page with a
confirm button and does not use up the token.

```bash
curl -s "$BASE/v1/ngo-applications/verify-contact-email?token=<TOKEN>"
```

```html
<!doctype html>
<html lang="en">
  <meta charset="utf-8" /><title>Verify contact email</title>
  <p>Confirm this email address for your NGO application.</p>
  <form method="post" action="/v1/ngo-applications/verify-contact-email?token=<TOKEN>">
    <button type="submit">Confirm email</button>
  </form>
</html>
```

### `POST /v1/ngo-applications/verify-contact-email`

Uses the token and marks the contact email as verified.

```bash
curl -s -X POST "$BASE/v1/ngo-applications/verify-contact-email?token=<TOKEN>"
```

```json
{ "verified": true }
```

An invalid, expired or already used token returns `400`:

```json
{ "error": "invalid_or_expired_token" }
```

## Conditional requests

Cacheable public endpoints return an `ETag`. Send it back in
`If-None-Match` to get an empty `304 Not Modified` while nothing has changed:

```bash
ETAG=$(curl -sI "$BASE/v1/impact" | awk -F': ' 'tolower($1)=="etag" {print $2}' | tr -d '\r')
curl -s -o /dev/null -w '%{http_code}\n' "$BASE/v1/impact" -H "If-None-Match: $ETAG"
```

```text
304
```

See [Caching and conditional requests](API.md#caching-and-conditional-requests)
for the list of cacheable endpoints.
