# Production migrations

Run migrations from a one-off job using the Docker build stage from the same
revision as the runtime image. This stage contains the locked Prisma CLI and
the checked-in migrations. Supply the production database connection through
the deployment platform's secret configuration.

```sh
docker build --target build -t streamgive-migrate .
docker run --rm -e DATABASE_URL streamgive-migrate npm run db:deploy
```

Before deployment, take a recoverable database backup and review the SQL.
Run the migration job once and wait for it to succeed before rolling out the
application. Keep the schema compatible with the previous running release
during rolling deployments. Introduce destructive changes in a later release
after the old application version has been retired.

If migration fails, halt rollout and inspect the database and Prisma migration
status. After confirming what was applied, fix forward using a reviewed
migration. When a change is reversible and the old schema is still compatible,
roll back the application separately. For an unrecoverable schema or data
change, stop writers and restore to a verified recovery point before deploying
the matching application version. Account for writes after that recovery
point before switching traffic back.
