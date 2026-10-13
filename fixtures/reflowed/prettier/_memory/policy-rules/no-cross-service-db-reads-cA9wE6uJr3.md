---
schema: 1
id: cA9wE6uJr3
memory_type: PolicyRule
title: No cross-service DB reads
status: accepted
date: 2026-02-12
last_confirmed: 2026-09-01
summary: A service in the commerce domain never reads another service's database directly and goes through that service's API or events.
applies_to: [domain:commerce]
owners: [team:commerce-architecture]
tags: [data-access, boundaries]
---

Each service owns its schema. Reach another service's data through its API or its published events, never through a shared connection or a replica read.
