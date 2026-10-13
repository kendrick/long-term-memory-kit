---
schema: 1
id: hT5cY8dUa6
memory_type: Decision
title: Adopt a message queue for order events
status: accepted
date: 2026-04-22
summary: Order-service publishes order lifecycle events to the shared message queue instead of calling downstream services directly.
applies_to: [service:order-service, domain:commerce]
owners: [team:commerce-architecture]
tags: [messaging, events]
deciders: [alice, bob]
---

## Context and Problem Statement

Order-service calls four downstream services synchronously, so one slow dependency stalls checkout.

## Decision Outcome

Publish order events to the shared queue and let consumers subscribe.

## Consequences

Checkout no longer waits on downstream work. Consumers must handle duplicate events.
