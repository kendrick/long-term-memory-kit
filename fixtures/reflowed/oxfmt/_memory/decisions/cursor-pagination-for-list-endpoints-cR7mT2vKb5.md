---
schema: 1
id: cR7mT2vKb5
memory_type: Decision
title: Cursor pagination for list endpoints
status: accepted
date: 2026-03-18
summary: List endpoints return an opaque next cursor instead of page numbers, superseding offset pagination.
supersedes: [oP4gN8zYa3]
applies_to: [service:order-service, domain:commerce]
owners: [team:commerce-architecture]
tags: [api, pagination]
---

## Context

Offset pages drifted as orders arrived and slowed on deep pages.

## Decision

Return an opaque cursor with each list response and accept it on the next call.

## Consequences

Page numbers are gone from the API. Existing clients move on their next release.
