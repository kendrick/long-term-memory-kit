# Use an event bus for order events

## Context and Problem Statement

Checkout, fulfillment, and billing each poll the orders service for changes. Polling adds load and delays reactions by up to a minute.

## Considered Options

* Keep polling
* Publish order events to a shared event bus
* Call downstream services directly

## Decision Outcome

Publish order events to a shared event bus, because it removes polling and keeps services decoupled.

### Consequences

Consumers must tolerate duplicate and out-of-order events.
