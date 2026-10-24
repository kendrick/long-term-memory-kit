# Decision Log

## Use ioredis for the Redis client

Picked ioredis over the old client for cluster support. See ADR 3.

## Cap retries at three per request

Outbound calls retry at most three times per request, with jittered backoff. Anything past that fails fast so a struggling provider can recover.

## Keep order IDs as ULIDs

Order IDs stay ULIDs so they sort by creation time without a separate index.
