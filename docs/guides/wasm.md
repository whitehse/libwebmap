# Building libwebmap WASM (no Emscripten)

## Decision

ADR-009 forbids Emscripten. WASM is produced with **clang** + **wasm-ld** and
the freestanding runtime in `wasm/webmap_wasm_rt.c` + free-list heap in
`wasm/webmap_heap.c` (**P4.3 / ADR-025**).

## Freestanding + free-list heap

| Concern | Solution |
|---------|----------|
| libc | Not linked (`-nostdlib -ffreestanding`) |
| `malloc` / `calloc` / `realloc` / `free` | **Free-list** with boundary tags + coalescing (`webmap_heap.c`) |
| `memcpy` / `memset` / `strlen` / … | Local implementations in `webmap_wasm_rt.c` |
| libm (`log`, `tan`, `cos`, …) | Soft-float approximations in `webmap_wasm_rt.c` |
| Entry | `--no-entry`; host instantiates and calls exports |
| Memory | Host imports linear memory (`--import-memory`); **heap base at 1 MiB** (below = stack/data; avoids wasm-ld stack collision) |

### Heap API (exports)

| Export | Purpose |
|--------|---------|
| `webmap_wasm_alloc(n)` | Same as `malloc` (staging / explicit host alloc) |
| `webmap_wasm_free(p)` | Real free (returns block to freelist) |
| `webmap_wasm_reset_arena()` | Wipe freelist + used accounting; **only** when no live `webmap_ctx` pointers |
| `webmap_wasm_heap_used` | Live used bytes |
| `webmap_wasm_heap_free_bytes` | Sum of free-list blocks |
| `webmap_wasm_heap_capacity` | Committed arena size from heap base |
| `webmap_wasm_heap_high_water` | Peak used since last reset |
| `webmap_wasm_heap_over_watermark` | `1` if used > watermark |
| `webmap_wasm_heap_set_watermark(bytes)` | Soft limit; `0` → default **75% of capacity** |

### Watermark / reload safety net

After heavy tile churn, if `webmap_wasm_heap_over_watermark()` is true (or
capacity keeps growing under fragmentation), the host should:

1. Destroy all map contexts (`webmap_destroy`).
2. Either call `webmap_wasm_reset_arena()` **or** re-instantiate the module, then
3. Recreate contexts and reload tiles.

Do **not** `reset_arena` while GPU/host still holds pointers into WASM memory
from `get_tile_layers`.

### Build

```bash
cmake -B build-wasm -S . \
  -DCMAKE_TOOLCHAIN_FILE=cmake/WasmToolchain.cmake \
  -DWEBMAP_BUILD_WASM=ON \
  -DWEBMAP_BUILD_TOOLS=OFF \
  -DWEBMAP_BUILD_TESTS=OFF \
  -DWEBMAP_BUILD_DEMO=OFF
cmake --build build-wasm
# → build-wasm/webmap.wasm
```

Copy into the demo (optional):

```bash
cp build-wasm/webmap.wasm demo/
```

Native freelist tests (no browser):

```bash
cmake -B build -S .
cmake --build build --target webmap_wasm_heap
ctest --test-dir build -R webmap_wasm_heap --output-on-failure
```

### Host instantiation (sketch)

```js
// Or use demo/display/wasm_host.js (P4.4/P4.13):
import { createWasmHost, parseWasmQuery } from "./display/wasm_host.js";
// parseWasmQuery() → "auto" | "on" | "off"  (default auto)
const host = createWasmHost({ decodeAndDrop: true, maxTiles: 2 });
await host.init("./webmap.wasm");
const tile = host.parseWmapViaWasm(await (await fetch(url)).arrayBuffer());
// C tile cache emptied after extract when decodeAndDrop is true
```

Demo: basemap `.wmap` parse defaults to WASM **decode-and-drop** (P4.13). Use
**`?wasm=0`** for pure JS, **`?wasm=1`** to force the WASM path. See
[wasm-default-on-gate.md](wasm-default-on-gate.md).

Key exports for the tile path:

| Export | Role |
|--------|------|
| `webmap_wasm_abi_pack_ptr` | wasm32 packing table (ADR-024) |
| `webmap_create` / `webmap_create_with_config` | Context |
| `webmap_load_wmap_tile` | Ingest staging bytes |
| `webmap_wasm_layer_count` / `webmap_wasm_get_layer` | Flat layer views (u32 ptrs) |
| `webmap_wasm_alloc` | Staging slab + out buffers |

See [ADR-024](../decisions/024-wasm-host-contract.md).

## Why not wasi-libc?

WASI is fine for CLI tools but pulls a larger ABI surface for a browser map
module. The freestanding path keeps the artifact minimal and matches ADR-009.

## Why not host-imported malloc?

Valid under ADR-009, but **not** the primary reclaim strategy (ADR-025). The
free-list stays self-contained; host malloc may remain a lab CMake option later.
