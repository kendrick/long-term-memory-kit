---
schema: 1
id: oP4gN8zYa3
memory_type: Decision
title: Offset pagination for list endpoints
status: superseded
date: 2024-08-06
summary: List endpoints paginate with page and size parameters, which cursor pagination later superseded.
superseded_by: cR7mT2vKb5
applies_to: [service:order-service, domain:commerce]
owners: [team:commerce-architecture]
tags: [api, pagination]
---

## Context

Early clients needed numbered pages.

## Decision

Paginate list endpoints with page and size query parameters.

## Consequences

Deep pages get slow and shift when rows are inserted.
