---
schema: 1
id: nR5hB2yTq8
memory_type: PolicyRule
title: Relational stores use PostgreSQL
status: accepted
date: 2026-02-10
last_confirmed: 2026-09-01
summary: A service in the commerce domain that needs a relational store runs PostgreSQL, not another engine.
applies_to: [domain:commerce, system:data-platform]
owners: [team:commerce-architecture]
tags: [database, postgres, relational-storage, data-platform, commerce-services, persistence-layer, operational-standards]
---

New and migrated services use PostgreSQL for relational data. The Postgres everywhere Decision gives the reasoning.
