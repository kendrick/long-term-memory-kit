# Decision Log

## Use ioredis for the Redis client

Picked ioredis over the old client for cluster support. See ADR 3.

## 2026-10-02: Batch order events per partition

Order events are published in batches of up to 100, grouped by partition key, so one slow partition never holds up the rest. Ordering holds within a partition only.

## Cap retries at three per request

Outbound calls retry at most three times per request, with jittered backoff. Anything past that fails fast so a struggling provider can recover.

## Keep order IDs as ULIDs

Order IDs stay ULIDs so they sort by creation time without a separate index.
