---
status: accepted
date: 2026-06-15
decision-makers: [platform-team]
---

# Retry budget for outbound calls

## Context and Problem Statement

Retries on outbound calls from the order service multiplied during the June payments outage, and the retry storm kept the provider down longer than the outage itself.

## Considered Options

- Unbounded retries with exponential backoff
- A fixed retry budget per request
- No retries; fail fast and let the caller decide

## Decision Outcome

Chosen option: "A fixed retry budget per request", because it bounds the extra load a single request can put on a struggling dependency.
