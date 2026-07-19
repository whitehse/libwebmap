# TODO — libwebmap

## Track 4 (program design) — complete

P4.0–P4.13 landed on `main` (`17f46d2` + ADR-019 closeout). See
`docs/guides/wasm-default-on-gate.md` and ADRs 019–027.

## Done

- [x] Scaffold: CMake, pure C11, agent-ready docs, LICENSE
- [x] Core map context: camera, tile cache, event ring
- [x] Web Mercator projection + tile id helpers
- [x] `.wmap` v1 encode/decode + roundtrip tests
- [x] Dynamic overlays (fiber/electric status classes)
- [x] Overlay → GPU buffer build (camera-relative mercator)
- [x] Minimal MVT decoder + synthetic smoke tests
- [x] `gfvtile2wmap` host utility
- [x] ADRs including **no Emscripten** (009) and clang WASM (010)
- [x] Wasm toolchain file + export entry stub
- [x] **Host WebGPU demo** (`demo/index.html` + `main.js` + WGSL)
- [x] **Freestanding WASM** with bump allocator + soft math (`wasm/webmap_wasm_rt.c`, `docs/guides/wasm.md`)
- [x] **Visible tile frustum** from width/height/zoom (`webmap_visible_tile_range`)
- [x] **Batch directory mode** for `gfvtile2wmap` (`--dir`, `--zmin/max`, `--bbox`)
- [x] **Polygon ear-clip fill** for MVT polygons
- [x] **GeoFabrik Oklahoma Shortbread** sample: county-limited extract + fixture + demo tiles

## Medium priority

- [x] Fiber hover magnifier (dwell + schematic + `splice_detail/` JSON)
- [x] Magnifier rework: geo approach layout, mouse-pan explore, fiber-chip path trace
- [x] **ADR-017 three-tier data boundary** (sources / packages / display)
- [x] **Format ownership docs** (`docs/formats/`: packages, fmap, fiber-design-input)
- [x] **Basemap pipeline** (`tools/basemap_pipeline/` + package manifest fields)
- [x] **fiber2features** host tool in libwebmap (vendored SQLite + schema_map)
- [x] **Fiber package recipe** (`build_fiber_package.sh`, `FIBER_DESIGN_DB`, optional diagrams)
- [x] **fmap v3** cable GUID writer + dual parser + pick plumbing
- [x] **path_index export** (`export_path_index.py` → cable_to_paths + paths.jsonl)
- [x] **Fiber path trace UI** (ADR-018, `fiber_trace.js`, dim + path list)
- [x] **Demo fiber package regen** path (fmap v3 + path_index via build_fiber_package)
- [x] **Weather overlay package schema** (`docs/formats/weather-package.md` + fixture)
- [x] **CrescentLink adapter cleanup** (Tier A docs; map bake → libwebmap)
- [ ] Label / glyph atlas plumbing (or explicit deferral ADR)
- [ ] Style document (subset of MapLibre style for paint properties)
- [ ] Overlay spatial index for large feature counts
- [ ] Integration sketch with netforensics status events
- [ ] pkg-config + install man page
- [ ] Fuzz harness for `.wmap` and MVT parsers
- [x] Wire WASM exports into demo basemap parse path (`?wasm=1`; style/extrude still JS host)
- [x] **P4.0** Memory measurement harness (`mem_stats.js` + HUD + [memory-attribution.md](docs/guides/memory-attribution.md))
- [x] **P4.1** Measurement budgets ADR ([019](docs/decisions/019-memory-budgets-from-measurement.md))
- [x] **P4.2** Tile cache eviction + max_tiles HUD (C LRU + `tile_cache.js` + `?max_tiles=`)
- [x] **P4.3** Freestanding WASM free-list reclaim (+ watermark; ADR-025)
- [x] **P4.4** WASM host contract (ABI pack, flat `get_layer`, staging; ADR-024)
- [x] **P4.5** Demo WASM basemap path (`wasm_host.js`)
- [x] **P4.6** Compare JS vs WASM parse (`tools/compare_wasm_parse.mjs`; gate doc)
- [x] **P4.7** Weather package host paint + opacity (`weather_layer.js`, ADR-022)
- [x] **P4.8** Glass UI tokens + CSS (`glass_ui.css`, ADR-021)
- [x] **P4.9** Dynamic feed offline + optional WS (`dynamic_feed.js`, ADR-023)
- [x] **P4.10** Schematic layout WASM/C export (`webmap_schematic_layout`, ADR-020)
- [x] **P4.11** Magnifier consumes layout export (`?schematic=`)
- [x] **P4.12** Optional WebGPU glass lens (`?glass_gpu=1`, ADR-027)
- [x] **P4.13** WASM default **auto** + decode-and-drop (`webmap_drop_tile`, `?wasm=0` opt-out)

## Low priority

- [ ] Pitch/bearing matrices for non-nadir views
- [ ] Multiple overlay GPU layers split by feature_class
- [ ] Shared customer join helper API
- [x] Real free-list malloc for long-lived WASM sessions (P4.3 / ADR-025)

## Testing gaps

- [x] Fixture Oklahoma Tulsa tile decode (`webmap_fixture_ok`)
- [x] Frustum multi-tile coverage (`webmap_frustum`)
- [x] Polygon index count (`webmap_polygon`)
- [x] Eviction path under `max_tiles` (`tests/test_tile_eviction.c`)
- [ ] Queue overflow under tiny `event_queue_size`
- [ ] Malformed MVT / truncated `.wmap` rejection cases
- [ ] Valgrind clean on all tests
