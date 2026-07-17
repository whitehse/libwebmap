# AGENTS.md — libwebmap

## What this is

**libwebmap** is a pure C **WebGPU-oriented web map** library for status maps
of rural fiber broadband and rural electric systems. Structure is inspired by
[maplibre-rs](https://github.com/maplibre/maplibre-rs) (map / camera / tiles /
layers / GPU buffers) but implemented in C11 and compiled to WASM with
**standard CMake + clang**, not Emscripten.

- **Language:** C11
- **Build:** CMake ≥ 3.20, clang (native and `wasm32`)
- **Tests:** ctest
- **License:** MIT

## Key properties

- **Holds map data** — basemap tiles (`.wmap`) and dynamic overlays stay in the library (ADR-008).
- **WebGPU-friendly** — exposes vertex/index buffers and descriptors; host owns the GPU device (ADR-007).
- **No Emscripten** — WASM via clang `--target=wasm32` + `wasm-ld` only (ADR-009).
- **Syscall-free core** — no sockets/files in library code; host feeds tiles and overlay updates (ADR-004).
- **Callback-free** — pull events via `webmap_next_event` (sibling contract).
- **Utility** — `gfvtile2wmap` converts GeoFabrik experimental MVT (`.pbf`) → `.wmap` (ADR-011).

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md). Data enters through a **three-tier
boundary** (ADR-017): source adapters → map packages → display (this library).
Design + migration plan: [docs/designs/data-sources-display-separation.md](docs/designs/data-sources-display-separation.md).

## Build & test

```bash
cmake -B build -S .
cmake --build build
ctest --test-dir build --output-on-failure
```

WASM (no Emscripten) — freestanding bump allocator + soft math:

```bash
cmake -B build-wasm -S . \
  -DCMAKE_TOOLCHAIN_FILE=cmake/WasmToolchain.cmake \
  -DWEBMAP_BUILD_WASM=ON -DWEBMAP_BUILD_TOOLS=OFF -DWEBMAP_BUILD_TESTS=OFF
cmake --build build-wasm
# → build-wasm/webmap.wasm  (see docs/guides/wasm.md)
```

Convert GeoFabrik / Shortbread MVT:

```bash
# single tile
./build/gfvtile2wmap -z 10 -x 238 -y 401 tile.pbf -o tile.wmap
# directory tree {z}/{x}/{y}.pbf
./build/gfvtile2wmap --dir data/oklahoma_counties_pbf -o out_wmap --zmin 8 --zmax 10
```

Oklahoma county pipeline + WebGPU demo:

```bash
# docs/guides/oklahoma-tiles.md
./tools/prepare_demo_tiles.sh   # → demo/basemap/
# fiber data (from crescentlink_export):
#   ./fiber2features fiber_design.sqlite -o demo/fiber_data
#   ln -sfn ~/crescentlink_export/splice_diagrams demo/splice_diagrams
python3 -m http.server -d demo 8765   # Chrome/Edge + WebGPU
# fiber guide: docs/guides/fiber-map-data.md
```

## Session startup

1. `pwd` and confirm you are in `libwebmap`
2. Read this file and [ARCHITECTURE.md](ARCHITECTURE.md)
3. `cmake --build build && ctest --test-dir build --output-on-failure`
4. Skim [docs/DOMAIN.md](docs/DOMAIN.md) before extending tile formats or overlays

## Directives

- **Must** keep the core free of syscalls and blocking I/O
- **Must** emit control results through the event queue (no callbacks)
- **Must not** introduce Emscripten, em++ , or emcmake (ADR-009)
- **Must** compile WASM only with clang + wasm-ld / CMake toolchain (ADR-010)
- **Prefer** preconverted `.wmap` tiles in the browser path; run MVT decode on the host tool
- **Prefer** status colors via `webmap_status_rgba` for fiber/electric overlays
- **Avoid** embedding a full WebGPU implementation inside the library; export GPU-ready data
- **Never** allocate unbounded on hot overlay rebuild paths without fixed caps (config)

## Definition of done

- [ ] `cmake --build build` succeeds with `-Werror`
- [ ] `ctest --test-dir build` passes
- [ ] New public API documented in `include/webmap.h` and linked from `docs/`
- [ ] Significant design choices have an ADR under `docs/decisions/`
- [ ] WASM path still documents “no Emscripten”

## ADR references

| ADR | Topic |
|-----|-------|
| 001 | Agent-ready documentation |
| 002 | Pure C11 choice |
| 003 | Ring-buffer event queue |
| 004 | No syscalls / host I/O |
| 005 | No callbacks |
| 006 | maplibre-rs-inspired structure |
| 007 | WebGPU-oriented GPU buffers |
| 008 | Library holds map data |
| 009 | **No Emscripten for WASM** |
| 010 | CMake + clang WASM toolchain |
| 011 | GeoFabrik MVT → `.wmap` utility |
| 012 | Rural fiber + electric status map domain |
| 013 | Strict compiler warnings |
| 014 | Plumbing vs host renderer boundary |
| 015 | Fiber data / display split |
| 016 | Fiber hover magnifier + compact splice detail |
| 017 | **Three-tier data boundary** (sources / packages / display) |

## API surface (quick)

| Function | Purpose |
|----------|---------|
| `webmap_create` / `_with_config` | Lifecycle |
| `webmap_set_camera` / `webmap_update_visible_tiles` | Viewport |
| `webmap_load_wmap_tile` | Ingest basemap tile blob |
| `webmap_upsert_overlay` / `webmap_remove_overlay` | Dynamic status features |
| `webmap_build_overlay_gpu` | GPU buffer for overlays |
| `webmap_get_tile_layers` | GPU buffers for a basemap tile |
| `webmap_next_event` | Pull events |
| `webmap_wmap_encode` / `webmap_mvt_decode` | Format helpers / tool |
