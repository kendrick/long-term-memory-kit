---
schema: 1
id: vD8mH3zQb5
memory_type: PolicyRule
title: Structured JSON logging
status: accepted
date: 2025-10-07
summary: Acme services write logs to stdout as one JSON object per line.
applies_to: [domain:commerce, system:observability]
owners: [team:platform-engineering]
tags: [logging]
---

Log one JSON object per line to stdout with level, timestamp, and trace id fields. Free-text log lines fail the pipeline parser.
