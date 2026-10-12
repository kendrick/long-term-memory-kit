# 3. No shared databases

## Status

Accepted

## Context

Two Acme services once read each other's tables, so a schema change in one broke the other without warning.

## Decision

Services never read another service's tables. Data crosses service boundaries through APIs or events only.

## Consequences

Some data is duplicated across services, and each owner can change its schema freely.
