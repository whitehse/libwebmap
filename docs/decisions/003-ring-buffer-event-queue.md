# ADR-003: Ring-Buffer Event Queue

## Status

Accepted

## Date

2026-07-15

## Context

Hosts need asynchronous signals (tile needed, overlay changed) without
callbacks that re-enter library code.

## Decision

Use a fixed-capacity pull queue (`webmap_next_event`). On overflow, replace
oldest with `WEBMAP_EVENT_QUEUE_OVERFLOW` and increment `webmap_dropped_count`
(sibling ADR-003 parity).

## Consequences

- Bounded memory; caller-controlled drain rate; reentrancy-safe

## Alternatives considered

- Callbacks — rejected (ADR-005)
