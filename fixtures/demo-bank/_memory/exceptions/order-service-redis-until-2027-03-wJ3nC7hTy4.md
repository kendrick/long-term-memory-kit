---
schema: 1
id: wJ3nC7hTy4
memory_type: Exception
title: order-service may use Redis until 2027-03
status: accepted
date: 2026-05-05
effective_to: 2027-03-31
review_by: 2027-02-15
summary: Order-service may read inventory-service's Redis directly for stock levels until 2027-03-31, despite the no-cross-service-DB-reads PolicyRule.
applies_to: [service:order-service]
owners: [team:commerce-architecture]
related: [constrained_by::cA9wE6uJr3]
---

Order-service reads stock levels straight from inventory-service's Redis until inventory publishes a stock-changed event stream. Other services still go through inventory's API.
