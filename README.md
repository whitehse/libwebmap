# libwebmap

Pure C **WebGPU-oriented web map** library for rural **fiber broadband** and
**electric** status maps. Inspired by the structure of maplibre-rs; compiled
with **CMake + clang** to native and WASM (**not Emscripten**).

Libraries stay thin on I/O (syscall-free, callback-free). The host owns WebGPU
devices and network fetch. libwebmap **holds** basemap tiles and dynamic
overlays and exposes GPU-ready buffers.

## Quick start

```bash
cmake -B build -S .
cmake --build build && ctest --test-dir build --output-on-failure
```

```c
#include <webmap.h>

webmap_ctx_t *ctx = webmap_create();
webmap_load_wmap_tile(ctx, wmap_bytes, wmap_len);

webmap_overlay_desc_t d = {0};
/* ... set fiber span geometry + WEBMAP_STATUS_DOWN ... */
webmap_upsert_overlay(ctx, &d);

webmap_gpu_layer_t gpu;
webmap_build_overlay_gpu(ctx, &gpu, 1);
/* host uploads gpu.vertices / gpu.indices to WebGPU */

webmap_destroy(ctx);
```

### Convert GeoFabrik experimental vector tiles

```bash
# Oklahoma Shortbread → basemap package (see docs/guides/oklahoma-tiles.md)
python3 tools/basemap_pipeline/extract_region.py
./tools/basemap_pipeline/build_package.sh    # → demo/basemap/
python3 -m http.server -d demo 8765
```

```bash
./build/gfvtile2wmap -z 10 -x 238 -y 401 path/to/tile.pbf -o tile.wmap
./build/gfvtile2wmap --dir data/oklahoma_counties_pbf -o out --zmin 8 --zmax 10
```

### WASM (clang only, no Emscripten)

```bash
cmake -B build-wasm -S . \
  -DCMAKE_TOOLCHAIN_FILE=cmake/WasmToolchain.cmake \
  -DWEBMAP_BUILD_WASM=ON -DWEBMAP_BUILD_TOOLS=OFF -DWEBMAP_BUILD_TESTS=OFF
cmake --build build-wasm
cp build-wasm/webmap.wasm demo/
```

## Documentation

| Doc | Purpose |
|-----|---------|
| [AGENTS.md](AGENTS.md) | Agent entry point, directives, ADR index |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Codemap, data flow, invariants |
| [docs/README.md](docs/README.md) | Documentation index |
| [docs/DOMAIN.md](docs/DOMAIN.md) | Tiles, utility domain, status semantics |
| [docs/decisions/](docs/decisions/) | Architecture Decision Records |
| [docs/designs/](docs/designs/) | Design docs (data boundary, path trace) |
| [TODO.md](TODO.md) | Remaining implementation work |

## License

MIT — see [LICENSE](LICENSE).
