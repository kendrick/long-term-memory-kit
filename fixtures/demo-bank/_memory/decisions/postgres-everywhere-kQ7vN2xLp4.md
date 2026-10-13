---
schema: 1
id: kQ7vN2xLp4
memory_type: Decision
title: Postgres everywhere
status: accepted
date: 2026-02-10
last_confirmed: 2026-09-01
summary: Acme services use PostgreSQL as their relational store, superseding the MySQL decision for all new and migrated services.
supersedes: [mB3tR9wZe1]
applies_to: [domain:commerce, system:data-platform]
owners: [team:commerce-architecture]
tags: [database, postgres]
source_refs: [fixtures/hydration-sources/adr/0001-postgres.md]
---

## Context

Two relational engines doubled our operational load.

## Decision

Use PostgreSQL for every service that needs a relational store.

## Consequences

One engine to patch and back up. Existing MySQL services migrate on their next major change.
