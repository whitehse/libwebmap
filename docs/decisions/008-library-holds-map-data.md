# ADR-008: Library Holds Map Data

## Status

Accepted

## Date

2026-07-15

## Context

Many web maps stream tiles and discard them aggressively. This product needs
low-latency status visualization over a fixed rural territory with rich basemap
detail and frequent overlay updates.

## Decision

libwebmap is designed to **hold all or most mapping data to be displayed** in
the active session:

- Basemap tiles in a bounded in-memory cache (`max_tiles`)
- Dynamic overlays up to `max_overlays`

Eviction is explicit (capacity pressure emits `TILE_EVICTED`). Hosts should
preconvert and load the service-area basemap rather than relying solely on
on-demand MVT parse in the hot path.

## Consequences

- Higher RAM use; smoother interaction; converter becomes a critical pipeline

## Alternatives considered

- Stateless tile decoder only — rejected; conflicts with stated product goal
