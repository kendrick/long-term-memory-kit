---
schema: 1
id: gN5yD9sMe2
memory_type: Context
title: order-service overview
status: accepted
date: 2026-06-10
last_confirmed: 2026-09-01
summary: Order-service owns carts, checkout, and order state for Acme commerce and publishes order events.
applies_to: [service:order-service, domain:commerce]
owners: [team:commerce-architecture]
---

Order-service is the system of record for carts and orders. Billing and fulfillment consume its events.
