---
schema: 1
id: pL2sG4nVq0
memory_type: Decision
title: Adopt OpenTelemetry tracing
status: proposed
date: 2026-09-30
review_by: 2026-12-15
summary: Acme services emit traces through OpenTelemetry instead of the vendor tracing agent.
applies_to: [platform:kubernetes, system:observability]
owners: [team:platform-engineering]
---

## Context

The vendor agent ties us to one tracing backend.

## Decision

Instrument services with OpenTelemetry SDKs.

## Consequences

Teams re-instrument once. Backend choice becomes a config change.
