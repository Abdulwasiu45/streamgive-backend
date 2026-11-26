# ADR-0001: Run the API and background workers in one process

- Status: Accepted
- Date: 2026-11-22

## Context

The backend serves HTTP requests and runs the Soroban indexer and notification
dispatcher. Keeping these responsibilities together avoids operating separate
services with separate configuration and lifecycle management.

## Decision

Start the API and background workers in the same Node.js process.

## Consequences

Startup, shutdown, configuration, and the database client are shared. Some
operational state remains process-local, including rate limits, admin signature
replay protection, and metrics. PostgreSQL advisory locking coordinates the
indexer worker, but does not make all process-local state shared across replicas.
Multi-instance deployment therefore requires accounting for that state.
