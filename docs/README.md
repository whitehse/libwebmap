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
- [decisions/](decisions/) — Architecture Decision Records (ADRs 001–014)
- [guides/wasm.md](guides/wasm.md) — freestanding clang WASM (no Emscripten)
- [guides/oklahoma-tiles.md](guides/oklahoma-tiles.md) — GeoFabrik Shortbread county pipeline

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

| Library / app | Role relative to libwebmap |
|---------------|----------------------------|
| **libdom** | DOM/HTML plumbing + WASM bridge patterns |
| **libipfix / libbmp / libnetdiag** | Network forensics telemetry sources for overlays |
| **netforensics** | Possible producer of path / outage correlated events |
| **gfvtile2wmap** | Offline GeoFabrik VT → `.wmap` |
