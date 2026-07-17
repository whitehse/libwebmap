# ARCHITECTURE.md — libwebmap

## Overview

libwebmap is a **map data + GPU descriptor** engine for a performant web map.
It is structured similarly to maplibre-rs modules (map context, camera, tile
pyramid, layers, renderable buffers) but:

- Implemented in **pure C11**
- Targets **WebGPU** buffer layouts (not WebGL)
- Compiles to **WASM via clang/CMake** (never Emscripten)
- Is designed as a **status map** for rural fiber + rural electric networks,
  with basemap geometry held in-process and dynamic overlays fed from sibling
  software under `~/` (netforensics, CPE telemetry, inventory systems, …)

The library does **not** open network connections or call the WebGPU C API
directly. The host (browser JS with `navigator.gpu`, or a native wgpu app)
creates the device, uploads buffers, and draws.

## Three-tier data boundary (ADR-017)

libwebmap is **Tier C (display)**. Upstream data enters through **packages** and
host-fed overlays — not by embedding vendor dump parsers in the C core.

| Tier | Role | Examples |
|------|------|----------|
| **A — Source adapter** | Vendor dumps → normalized intermediates | CrescentLink GPKG → `fiber_design.sqlite` + path walk; GeoFabrik MBTiles extract; future weather adapters |
| **B — Map package bake** | Intermediates → on-disk packages | `gfvtile2wmap` → basemap `.wmap`; fiber package `.fmap` / features / splice_detail (tools migrate under `tools/`) |
| **C — Display** | Hold data, GPU descriptors, paint | This library + `demo/display/` |

```
Tier A                     Tier B                          Tier C
────────                   ──────                          ──────
CrescentLink GPKG ──► fiber_design.sqlite ──► fiber package ──► demo host
GeoFabrik Shortbread ──► MVT/PBF ──► basemap package ──► libwebmap core
Weather (future) ──► raw ──► weather package ──► host overlays
```

**Rules (summary):** Tier C never imports CrescentLink/GPKG types. Tier B does
not open vendor GPKG dumps. Display formats (`.wmap`, `.fmap`, path_index,
manifests, weather package schema) are owned by this repo. HTML splice diagrams
and absolute sibling paths are optional inputs, not required for paint. Residual
ECOEC CRS (EPSG:2267 GPKG geom) in fiber bake is documented until Tier A emits
WGS84 WKB. Weather/wind: [docs/formats/weather-package.md](docs/formats/weather-package.md).

Full decision: [docs/decisions/017-three-tier-data-boundary.md](docs/decisions/017-three-tier-data-boundary.md).  
Design + PR plan: [docs/designs/data-sources-display-separation.md](docs/designs/data-sources-display-separation.md).

## Codemap

| Path | Role | Tier |
|------|------|------|
| `include/webmap.h` | Public API: camera, tiles, overlays, events, `.wmap` | C |
| `include/webmap_mvt.h` | MVT decoder API (host tool + optional native ingest) | B/C |
| `src/webmap.c` | Context, projection, tile cache, overlays, `.wmap` I/O | C |
| `src/webmap_mvt.c` | Minimal Mapbox Vector Tile protobuf decoder | B |
| `tools/gfvtile2wmap/` | GeoFabrik experimental VT → `.wmap` CLI | B |
| `wasm/webmap_wasm_entry.c` | Freestanding WASM export surface | C |
| `wasm/webmap_wasm_rt.c` | Bump `malloc` + soft math (no Emscripten) | C |
| `cmake/WasmToolchain.cmake` | clang `wasm32` toolchain (no Emscripten) | — |
| `demo/` | WebGPU host (WGSL) + optional `webmap.wasm` | C |
| `demo/display/` | Fiber paint: style, .fmap parse, symbols, hover magnifier | C |
| `tools/export_splice_detail.py` | design DB → compact per-SP JSON for magnifier | B |
| `tools/export_path_index.py` | design DB `fiber_paths` → path_index/ browser files | B |
| `tools/build_fiber_package.sh` | One-shot fiber package (`FIBER_DESIGN_DB`, optional diagrams) | B |
| `tools/gfvtile2wmap/` | Single-tile + `--dir` batch converter | B |
| `tools/basemap_pipeline/` | Shortbread MBTiles → PBF → basemap package | A/B |
| `tools/fiber2features/` | Design DB → `.fmap` fiber package (vendored SQLite) | B |
| `tools/schema/schema_map.sql` | Map tables DDL for fiber package | B |
| `tools/third_party/sqlite/` | SQLite amalgamation (host tools only) | B |
| `tools/extract_oklahoma_counties.py` | Wrapper → `basemap_pipeline/extract_region.py` | A/B |
| `tools/prepare_demo_tiles.sh` | Wrapper → `basemap_pipeline/build_package.sh` | B |
| `data/` | GeoFabrik Shortbread + county extracts | inputs |
| `fixtures/tulsa_z10/` | CI fixture tile | — |
| `tests/` | Smoke, frustum, polygon, Oklahoma fixture | — |
| `docs/DOMAIN.md` | Domain: tiles, utilities, status semantics | — |
| `docs/decisions/` | ADRs | — |
| `docs/designs/` | Design docs (boundary, path trace plan) | — |
| `docs/formats/` | Package / `.fmap` / design-DB contracts (normative) | — |
| `docs/guides/` | WASM + Oklahoma tile + fiber data guides | — |
| `TODO.md` | Living progress tracker | — |

## Module map (maplibre-rs analogue)

```
┌─────────────────────────────────────────────────────────────┐
│  Host (browser WebGPU / native wgpu / status dashboard)     │
│    device, queue, shaders, fetch/XHR, UI                     │
└───────────────────────────┬─────────────────────────────────┘
                            │ feed bytes / pull events / read GPU descs
┌───────────────────────────▼─────────────────────────────────┐
│  webmap_ctx  (Map)                                          │
│    camera ──► visible tile set ──► NEED_TILE events         │
│    tile cache (.wmap layers → vertex/index buffers)         │
│    overlay store (fiber / power / customers / alerts)       │
│    event ring (pull)                                        │
└───────────────────────────┬─────────────────────────────────┘
                            │ offline
┌───────────────────────────▼─────────────────────────────────┐
│  gfvtile2wmap  (host tool)                                  │
│    GeoFabrik MVT .pbf  ──►  tessellate  ──►  .wmap blobs    │
└─────────────────────────────────────────────────────────────┘
```

| maplibre-rs idea | libwebmap |
|------------------|-----------|
| Map + schedule | `webmap_ctx_t` |
| Camera / view | `webmap_camera_t`, `webmap_set_camera` |
| Tile pyramid | `webmap_tile_id_t`, Web Mercator helpers |
| Style/layers | `webmap_gpu_layer_t` + kind/class enums |
| wgpu renderer | Host WebGPU; library supplies buffers |
| Tile source | Preconverted `.wmap` or host-fed MVT tool |

## Data flow

### Basemap (Tier A extract → Tier B package → Tier C)

1. **Source (A):** GeoFabrik Shortbread / MVT extract → `{z}/{x}/{y}.pbf` tree.
2. **Package (B):** `gfvtile2wmap` decodes MVT, colors by layer heuristics, packs `.wmap`.
3. **Display (C):** host loads `.wmap` bytes → `webmap_load_wmap_tile`.
4. Host calls `webmap_get_tile_layers` and uploads `vertices` / `indices` to GPUBuffer.

### Fiber design package (Tier A design DB → Tier B package → Tier C host)

1. **Source (A):** Vendor adapter (today: crescentlink_export) writes
   `fiber_design.sqlite` and optional optical path tables / HTML diagrams.
2. **Package (B):** Bake tools produce a fiber package: `.fmap` tiles,
   `features.sqlite`, optional `splice_detail/`, path_index (planned), manifest.
   Map-facing bake tools are owned by this repo (some still live in the adapter
   until the move PRs land — see ADR-017).
3. **Display (C):** `demo/display/` paints features; core may also take status
   overlays via `webmap_upsert_overlay`.

### Dynamic status (fiber + electric overlays)

1. Upstream systems produce feature updates (span id, status, lon/lat path).
2. Host calls `webmap_upsert_overlay` (no network inside libwebmap).
3. Host calls `webmap_build_overlay_gpu` each frame or on change; uploads buffers.
4. Status colors default from `webmap_status_rgba` (ok / degraded / down / maint).

## .wmap binary (v1)

Little-endian layout (see `webmap_wmap_encode`):

- magic `WMAP`, version `1`
- tile `z, x, y`
- layers: kind, feature_class, name, extent, vertices (`float x,y` + `rgba`), indices

Vertices are tile-local in MVT extent coordinates (typically 0..4096). Overlay
GPU build uses Web Mercator meters relative to camera center instead.

## Invariants

1. No syscalls, threads, or callbacks in library code.
2. Event queue capacity fixed at create; overflow → `WEBMAP_EVENT_QUEUE_OVERFLOW`.
3. Tile and overlay counts bounded by `webmap_config_t`.
4. Untrusted `.wmap` / MVT input must not OOB; failures return errors / free partial state.
5. Emscripten is never a build dependency (ADR-009).

## Deliberate absences

| What | Why |
|------|-----|
| Emscripten | Explicit product decision (ADR-009); clang WASM only |
| In-library WebGPU API calls | Portability; host owns device (ADR-007, ADR-014) |
| Full MapLibre style spec | Status map first; style JSON later |
| Network tile fetch | Host / CDN / service worker |
| Label collision / glyph atlas | Deferred (TODO) |
| 3D terrain | Out of scope for v0 status map |

## Relationship to sibling software

```
                    ┌─ Tier A (adapters) ─────────────────────────────┐
GeoFabrik Shortbread │  MBTiles / MVT extract                         │
crescentlink_export  │  GPKG → fiber_design.sqlite (+ path walk, HTML)│
netforensics / CPE   │  status / telemetry events                     │
weather (future)     │  alerts / wind feeds                           │
                    └──────────────────┬──────────────────────────────┘
                                       ▼
                    ┌─ Tier B (packages / bake tools) ────────────────┐
                    │  .wmap basemap · .fmap fiber · overlays schema  │
                    └──────────────────┬──────────────────────────────┘
                                       ▼
                    ┌─ Tier C (this repo display) ────────────────────┐
                    │  libwebmap C/WASM · demo host WebGPU · paint    │
                    └─────────────────────────────────────────────────┘
```

Rural operators view fiber spans, nodes, CPEs and electric lines, poles,
substations with shared customer context (many customers have both services).
Vendor design tools are adapters; **libwebmap displays packages and status**.
