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
- [ ] Wire WASM exports into demo draw path (currently demo parses `.wmap` in JS; WASM loads for ABI check)

## Low priority

- [ ] Pitch/bearing matrices for non-nadir views
- [ ] Multiple overlay GPU layers split by feature_class
- [ ] Shared customer join helper API
- [ ] Real free-list malloc for long-lived WASM sessions

## Testing gaps

- [x] Fixture Oklahoma Tulsa tile decode (`webmap_fixture_ok`)
- [x] Frustum multi-tile coverage (`webmap_frustum`)
- [x] Polygon index count (`webmap_polygon`)
- [ ] Eviction path under `max_tiles`
- [ ] Queue overflow under tiny `event_queue_size`
- [ ] Malformed MVT / truncated `.wmap` rejection cases
- [ ] Valgrind clean on all tests
