---
schema: 1
id: mB3tR9wZe1
memory_type: Decision
title: MySQL for new services
status: superseded
date: 2024-05-14
summary: New Acme services use MySQL as their relational store, which Postgres everywhere later superseded.
superseded_by: kQ7vN2xLp4
applies_to: [domain:commerce, system:data-platform]
owners: [team:commerce-architecture]
tags: [database, mysql]
---

## Context

The platform team only ran MySQL in 2024.

## Decision

Default new services to MySQL.

## Consequences

Services built on MySQL need migration once Postgres becomes the default engine.
