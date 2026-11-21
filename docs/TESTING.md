# Testing the backend

Vitest has two projects. `npm run test:unit` runs the explicitly listed unit tests without Postgres. `npm run test:integration` runs the remaining test files against Postgres serially. `npm test` runs both projects.

Start the test database with `docker compose up -d postgres`. Copy `.env.test.example` to `.env.test`, set `DATABASE_URL` to a dedicated disposable database such as `streamgive_test`, and run `npm run db:deploy:test`. An already exported `DATABASE_URL` can take precedence over the file, so clear it or confirm it points at your test database before running integration tests. Never point the suite at development or production data.

Run an individual file with:

```sh
npm exec -- vitest run --project unit test/metrics.test.ts
npm exec -- vitest run --project integration test/migrations.test.ts
```

Integration tests load `.env.test` through the project setup file. Tests that use `resetDb()` delete rows from application tables in dependency order between cases. They keep the schema in place, so migrations must be applied beforehand. If a reset fails, check the test database connection and migrations. Recreate only the disposable test database if you need a clean slate.
