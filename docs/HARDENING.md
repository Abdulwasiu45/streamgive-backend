# Deployer hardening checklist

Complete this checklist for each production deployment and repeat it after
changing the network topology, admin keys, or public frontend. Store secrets in
the hosting provider's secret manager; do not commit them or print them in logs.

## Trust proxy

- [ ] Set `TRUST_PROXY` to match the actual path between clients and the API.

  **Why it matters:** The API uses the request IP for rate-limit keys. Trusting
  forwarded headers from an untrusted source lets callers influence that IP;
  not trusting the real proxy can make every client appear to have the same IP.

  **Verify:** In staging, send requests through the configured proxy and confirm
  the API applies limits to separate client IPs. Where the app is reachable
  directly, confirm a caller cannot change its rate-limit identity merely by
  supplying `X-Forwarded-For`. Use `false` for direct connections without a
  trusted proxy, or configure a bounded hop count / trusted proxy addresses
  that match the deployment. The default is `true`, so review it rather than
  assuming it is suitable.

## Metrics access

- [ ] Set a strong, unique `METRICS_TOKEN` and keep it in the deployment's
  secret store.

  **Why it matters:** Without a token, `GET /metrics` is public and exposes
  operational and traffic details useful to anyone monitoring the service.

  **Verify:** With the token configured, request `/metrics` without a token and
  with an incorrect token; both should return `401`. A request with
  `Authorization: Bearer <METRICS_TOKEN>` should return Prometheus text. Avoid
  putting the token in shell history or shared logs.

## CORS origins

- [ ] Set `CORS_ORIGINS` to the exact HTTPS origins of the production browser
  clients, comma-separated when there is more than one. Remove development and
  preview origins that are no longer needed.

  **Why it matters:** An allowed browser origin can make requests from an
  administrator's browser. CORS is not authentication, and a broad origin list
  increases the sites that can interact with signed-in users.

  **Verify:** Send an `OPTIONS` preflight with an allowed `Origin` and confirm
  `Access-Control-Allow-Origin` matches it. Repeat with an unapproved origin
  and confirm the response does not grant that origin access. For example:

  ```sh
  curl -i -X OPTIONS https://api.example.org/v1/ngo-applications \
    -H 'Origin: https://app.example.org' \
    -H 'Access-Control-Request-Method: GET'
  ```

## Admin addresses and signing keys

- [ ] Configure only intended admin public keys in `ADMIN_ADDRESS` and/or
  `ADMIN_ADDRESSES`. Keep the corresponding secret keys outside the backend and
  protect them in the operators' wallet or key-management system.

  **Why it matters:** Any listed key can authorize admin API requests. An
  omitted allow-list leaves admin routes unavailable; an overly broad or
  outdated list grants unnecessary access.

  **Verify:** Check the configured addresses against the current operator
  roster. From a controlled client, confirm a valid request signed by a listed
  key succeeds and an unlisted key is rejected. During key rotation, overlap
  the old and new public keys only for the rotation period, then remove the
  retired key and verify it is rejected.

## Rate limits

- [ ] Review `RATE_LIMIT_MAX` and `RATE_LIMIT_WINDOW` for the expected API
  traffic, and `RATE_LIMIT_APPLICATION_MAX` and
  `RATE_LIMIT_APPLICATION_WINDOW` for public NGO application submissions.
  Keep the values positive and low enough to limit abuse without blocking
  normal clients.

  **Why it matters:** Limits reduce the impact of abusive request bursts. The
  configured global limit is per client IP; signed admin routes have a budget
  per configured admin address. The NGO application endpoint has a separate
  tighter limit. Limits are held in process memory, so each replica has its
  own budget and restarts clear counters.

  **Verify:** In staging, temporarily configure a small limit and issue requests
  above it within one window. Confirm the excess request returns `429` and
  includes `Retry-After` and `X-RateLimit-*` headers. Restore the production
  values afterward. If running multiple replicas, account for their separate
  budgets; see [Deployment](../DEPLOYMENT.md#running-more-than-one-instance)
  and keep the indexer/single-instance limitations in mind.

## Production mode and transport

- [ ] Set `NODE_ENV=production` and serve the API only over HTTPS, using the
  platform's TLS termination and secure configuration storage for credentials.

  **Why it matters:** Production mode disables interactive Swagger
  documentation, and HTTPS protects request headers and bodies in transit.
  Database URLs and any enabled webhook/email credentials must not be exposed.

  **Verify:** Confirm the public API redirects or otherwise refuses plain HTTP
  according to the hosting setup, `/docs` is unavailable in production, and
  deployment secrets are not present in the repository or application logs.
