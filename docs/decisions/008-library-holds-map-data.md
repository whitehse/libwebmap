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

Eviction is explicit (capacity pressure emits `TILE_EVICTED`). The victim is the
**least-recently-used** tile (`lru_stamp` updated on load and
`webmap_get_tile_layers`; P4.2). Hosts should preconvert basemap to `.wmap` and
may load on demand into a host-side LRU capped by the same `max_tiles` policy
(see `docs/guides/memory-attribution.md`).

## Consequences

- Higher RAM use; smoother interaction; converter becomes a critical pipeline

## Alternatives considered

- Stateless tile decoder only — rejected; conflicts with stated product goal
