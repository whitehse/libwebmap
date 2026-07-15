# ADR-006: maplibre-rs-Inspired Structure

## Status

Accepted

## Date

2026-07-15

## Context

maplibre-rs demonstrated a portable WebGPU map architecture: map context,
camera, tile pyramid, layers, and a GPU HAL. We want that *shape* without
adopting Rust or Bevy.

## Decision

Organize libwebmap around the same conceptual modules:

- Map context (`webmap_ctx_t`)
- Camera / viewport
- Slippy-map tiles and Web Mercator projection
- Layers with typed geometry
- GPU-ready vertex/index buffers

Style-spec completeness and a full render graph are **not** required for v0;
status-map overlays are first-class.

## Consequences

- Familiar mental model for map engineers; clear extension points

## Alternatives considered

- Thin wrapper around MapLibre GL JS — rejected; does not meet “hold data in WASM/C” goal
- Full style-spec clone on day one — deferred
