# ADR-0003: Keep admin signature replay state in memory

- Status: Accepted
- Date: 2026-11-22

## Context

Admin requests are signed with a timestamp that is accepted only within a
five-minute clock-skew window. A valid signature must not be accepted twice
during that window.

## Decision

Track recently used admin signatures in a process-local map and prune entries
after the replay window expires.

## Consequences

Replay checks need no database read or write on each admin request. The map is
cleared on restart and is not shared across replicas, so this protection is
limited to one process and the timestamp window. Deployments that need shared
replay protection must move this state to shared storage.
