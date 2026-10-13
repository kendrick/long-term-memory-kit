---
schema: 1
id: rX6jK1fWc9
memory_type: Decision
title: Trunk-based deployment
status: accepted
date: 2025-11-03
last_confirmed: 2026-08-20
summary: Acme services deploy from the main branch behind feature flags instead of long-lived release branches.
applies_to: [domain:commerce, platform:kubernetes]
owners: [team:platform-engineering]
---

## Context

Release branches drifted from main for weeks.

## Decision

Merge to main daily and gate unfinished work behind flags.

## Consequences

Flags need cleanup. Releases become routine.
