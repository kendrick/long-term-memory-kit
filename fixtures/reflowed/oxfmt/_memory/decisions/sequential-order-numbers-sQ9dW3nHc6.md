---
schema: 1
id: sQ9dW3nHc6
memory_type: Decision
title: Sequential order numbers
status: superseded
date: 2024-09-12
summary: Orders are numbered with a per-region counter, which ULID order identifiers later superseded.
superseded_by: uL5eX1pJd8
applies_to: [service:order-service, domain:commerce]
owners: [team:commerce-architecture]
tags: [identifiers]
---

## Context

Support staff read order numbers aloud over the phone.

## Decision

Number orders with a counter per region.

## Consequences

Order numbers repeat across regions and reveal order volume.
