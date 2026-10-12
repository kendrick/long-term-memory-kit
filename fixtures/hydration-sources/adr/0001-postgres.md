# 1. Use PostgreSQL

## Status

Accepted

## Context

Acme runs two relational engines, and the on-call load for patching and backing up both is doubling.

## Decision

We will use PostgreSQL for every service that needs a relational store.

## Consequences

One engine to operate. Existing MySQL services migrate on their next major change.
