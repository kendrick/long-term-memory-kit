---
schema: 1
id: eM1xS5gBo8
memory_type: PolicyRule
title: Services expose a health endpoint
status: accepted
date: 2025-09-18
summary: Every Acme service on Kubernetes exposes a /healthz endpoint that the platform probes.
applies_to: [platform:kubernetes]
owners: [team:platform-engineering]
---

Return 200 from /healthz only when the service can take traffic. The platform uses it for readiness and liveness probes.
