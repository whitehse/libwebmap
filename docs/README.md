# docs/README.md — libwebmap Documentation

## Overview

libwebmap is a pure C library for WebGPU-oriented web maps, aimed at **status
maps** for rural fiber broadband and rural electric cooperatives / utilities.
It inherits documentation structure and core engineering decisions from sibling
libraries (`libbmp`, `libipfix`, `libdom`, …) and adds map/WASM-specific ADRs.

## Purpose

Operators need a single map that holds detailed basemap geometry and overlays
live operational data (fiber span up/down, electric outages, shared customers).
libwebmap isolates data holding, projection, and GPU buffer packing from browser
I/O and WebGPU device management.

## Contents

- [DOMAIN.md](DOMAIN.md) — basemap tiles, MVT/GeoFabrik, fiber/electric domain
- [guides/fiber-map-data.md](guides/fiber-map-data.md) — fiber feature tables + display split
- [formats/](formats/) — **Normative** package / `.fmap` / design-DB contracts
  - [formats/data-packages.md](formats/data-packages.md) — manifests & versioning
  - [formats/fmap.md](formats/fmap.md) — `.fmap` tile bytes (v1–v3)
  - [formats/fiber-design-input.md](formats/fiber-design-input.md) — intermediate SQLite + CRS
  - [formats/path-index.md](formats/path-index.md) — optical path index for trace UI
  - [formats/weather-package.md](formats/weather-package.md) — weather/wind overlay package (schema + P4.7 host paint)
- [decisions/](decisions/) — Architecture Decision Records (ADRs 001–018, **020 schematic layout**, **021–023** host UI/weather/feed, 024–026 WASM, …)
- [designs/](designs/) — Design docs (data boundary, path trace, [optical budget](designs/optical-budget.md))
- [guides/wasm.md](guides/wasm.md) — freestanding clang WASM (no Emscripten)
- [guides/oklahoma-tiles.md](guides/oklahoma-tiles.md) — GeoFabrik Shortbread county pipeline
- [guides/memory-attribution.md](guides/memory-attribution.md) — **P4.0** demo memory harness + baseline protocol
- [guides/wasm-default-on-gate.md](guides/wasm-default-on-gate.md) — **P4.6** JS vs WASM gate (default remains JS)
- [guides/glass-ui.md](guides/glass-ui.md) — **P4.8** glass UI tokens (CSS + Canvas)
- [guides/dynamic-feed.md](guides/dynamic-feed.md) — **P4.9** map.dynamic fixture / WS consumer
- [guides/schematic-layout.md](guides/schematic-layout.md) — **P4.10** meet-point layout C/WASM blob

## Quick start

```c
#include <webmap.h>

webmap_ctx_t *ctx = webmap_create();
webmap_set_camera(ctx, &cam);
webmap_load_wmap_tile(ctx, data, len);

webmap_event_t ev;
while (webmap_next_event(ctx, &ev) == 1) {
    if (ev.type == WEBMAP_EVENT_NEED_TILE) {
        /* host fetch → webmap_load_wmap_tile */
    }
}
```

## Integration sketch (browser)

1. Load `webmap.wasm` built with clang (no Emscripten).
2. Create WebGPU device in JS; allocate GPUBuffers as tiles/overlays change.
3. Feed `.wmap` basemap tiles and upsert overlays from your status backend.
4. Draw with WGSL shaders reading `webmap_vertex_t` layout (`float2` + `u32 rgba`).

## Sibling map

Data enters libwebmap through the **three-tier boundary** (ADR-017): source
adapters → map packages → display. This repo is primarily Tier C plus Tier B
bake tools; vendor extractors are Tier A.

| Library / app | Tier | Role relative to libwebmap |
|---------------|------|----------------------------|
| **libdom** | — | DOM/HTML plumbing + WASM bridge patterns |
| **libipfix / libbmp / libnetdiag** | A (status) | Network forensics telemetry sources for overlays |
| **netforensics** | A (status) | Possible producer of path / outage correlated events |
| **crescentlink_export** | A | CrescentLink GPKG → design DB, path walk, optional HTML diagrams |
| **gfvtile2wmap** | B | Offline GeoFabrik VT → `.wmap` basemap package |
