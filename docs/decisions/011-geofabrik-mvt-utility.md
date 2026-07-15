# ADR-011: GeoFabrik MVT → .wmap Utility

## Status

Accepted

## Date

2026-07-15

## Context

GeoFabrik experimental vector tiles arrive as MVT protobuf (`.pbf`). Parsing
protobuf and tessellating geometry in the WASM hot path increases code size and
jank. Offline conversion can prebuild WebGPU-friendly buffers.

## Decision

Ship **`gfvtile2wmap`**, a host-side CLI that:

1. Reads one MVT `.pbf` tile (GeoFabrik experimental VT)
2. Decodes layers/features/geometry (minimal MVT implementation in `webmap_mvt.c`)
3. Writes a `.wmap` blob consumable by `webmap_load_wmap_tile`

MVT decode remains available as a library API for tests and future batch tools,
but the **recommended runtime path** is preconverted `.wmap`.

## Consequences

- Clear offline pipeline; smaller browser module if MVT code is not linked into WASM

## Alternatives considered

- Runtime MVT-only — rejected as primary for status-map performance goals
