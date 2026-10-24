# 3. Use ioredis for the Redis client

Date: 2026-05-02

## Status

Accepted

## Context

The order service caches cart totals and holds idempotency keys in Redis. The client we started with has no cluster support and drops commands silently when a connection resets.

## Decision

We will use ioredis for every Redis connection in the order service, in cluster mode against the shared cache.

## Consequences

Reconnects queue commands instead of dropping them. The team takes on ioredis's retry settings, which have to be tuned alongside the retry budget in ADR 4.
