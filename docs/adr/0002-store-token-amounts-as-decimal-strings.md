# ADR-0002: Store token amounts as decimal strings

- Status: Accepted
- Date: 2026-11-22

## Context

Contract amounts are integer values in token base units and can exceed the
precision JavaScript `number` can represent exactly.

## Decision

Persist and expose token amounts as base-10 strings. Use `BigInt` for exact
integer arithmetic, and do not convert amounts to JavaScript `number`.

## Consequences

Amounts retain their exact value through storage and JSON APIs. Consumers must
parse the strings with an integer type when doing arithmetic, and amounts for
different tokens must not be added together.
