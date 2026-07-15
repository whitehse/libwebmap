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

## Codemap

| Path | Role |
|------|------|
| `include/webmap.h` | Public API: camera, tiles, overlays, events, `.wmap` |
| `include/webmap_mvt.h` | MVT decoder API (host tool + optional native ingest) |
| `src/webmap.c` | Context, projection, tile cache, overlays, `.wmap` I/O |
| `src/webmap_mvt.c` | Minimal Mapbox Vector Tile protobuf decoder |
| `tools/gfvtile2wmap/` | GeoFabrik experimental VT → `.wmap` CLI |
| `wasm/webmap_wasm_entry.c` | Freestanding WASM export surface |
| `wasm/webmap_wasm_rt.c` | Bump `malloc` + soft math (no Emscripten) |
| `cmake/WasmToolchain.cmake` | clang `wasm32` toolchain (no Emscripten) |
| `demo/` | WebGPU host (WGSL) + optional `webmap.wasm` |
| `tools/gfvtile2wmap/` | Single-tile + `--dir` batch converter |
| `tools/extract_oklahoma_counties.py` | MBTiles → county PBF tree |
| `tools/prepare_demo_tiles.sh` | County PBF → demo `.wmap` + manifest |
| `data/` | GeoFabrik Shortbread + county extracts |
| `fixtures/tulsa_z10/` | CI fixture tile |
| `tests/` | Smoke, frustum, polygon, Oklahoma fixture |
| `docs/DOMAIN.md` | Domain: tiles, utilities, status semantics |
| `docs/decisions/` | ADRs |
| `docs/guides/` | WASM + Oklahoma tile guides |
| `TODO.md` | Living progress tracker |

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

### Basemap

1. Offline: `gfvtile2wmap` reads GeoFabrik experimental vector tiles (MVT `.pbf`).
2. Geometry is decoded, vertices colored by layer heuristics, packed into `.wmap`.
3. Runtime: host loads `.wmap` bytes and calls `webmap_load_wmap_tile`.
4. Host calls `webmap_get_tile_layers` and uploads `vertices` / `indices` to GPUBuffer.

### Dynamic status (fiber + electric)

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
GeoFabrik MVT ──gfvtile2wmap──► .wmap tiles ──► libwebmap (WASM)
netforensics / CPE / inventory ──status events──► overlays ──► libwebmap
libwebmap GPU descs ──host WebGPU──► status map UI
```

Rural operators view fiber spans, nodes, CPEs and electric lines, poles,
substations with shared customer context (many customers have both services).
