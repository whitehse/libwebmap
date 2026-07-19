# TODO — libwebmap

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
- [x] **P4.0 Memory measurement harness** (`demo/display/mem_stats.js` + sidebar HUD + [guides/memory-attribution.md](docs/guides/memory-attribution.md))
- [x] **P4.2** Tile cache eviction + max_tiles HUD (C LRU + `webmap_tile_eviction`; host `tile_cache.js` lazy + `?max_tiles=`)
- [x] **P4.3** Freestanding WASM free-list reclaim (+ watermark reload safety; ADR-025; `webmap_wasm_heap` ctest)
- [x] **P4.4** WASM host contract (ABI pack export, flat `get_layer`, staging; ADR-024)
- [x] **P4.5** Demo `?wasm=1` basemap path (`demo/display/wasm_host.js`)
- [x] **P4.6** Compare JS vs WASM parse; **default remains JS** (ADR-026; `tools/compare_wasm_parse.mjs`)
- [x] **P4.7** Weather package host paint + opacity (`demo/display/weather_layer.js`, ADR-022, fixture under `demo/weather/`)
- [x] **P4.8** Glass UI tokens + CSS (`demo/display/glass_ui.css`, `glass_tokens.js`, ADR-021, [guides/glass-ui.md](docs/guides/glass-ui.md))
- [x] **P4.9** Dynamic feed offline + optional WS (`demo/display/dynamic_feed.js`, ADR-023, fixture JSONL, [guides/dynamic-feed.md](docs/guides/dynamic-feed.md))
- [x] **P4.10** Schematic layout WASM/C export (`webmap_schematic_layout`, ADR-020, [guides/schematic-layout.md](docs/guides/schematic-layout.md))
- [x] **P4.11** Magnifier consumes layout export (`createSchematicLayoutService`, `?schematic=`, precomputed paint path)
- [x] **P4.12** Optional WebGPU glass lens (`?glass_gpu=1`, `glass_lens_gpu.js`, ADR-027)
- [x] **P4.13** WASM default auto + decode-and-drop (`webmap_drop_tile`, `?wasm=0` opt-out, gate green)

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
