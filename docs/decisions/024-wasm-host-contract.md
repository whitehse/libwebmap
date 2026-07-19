# ADR-024: WASM host contract (packing + staging)

## Status

Accepted

## Date

2026-07-18

## Context

The browser host must feed `.wmap` bytes into freestanding `webmap.wasm` and
read back GPU-ready layers. Host-native `sizeof`/`offsetof` **disagree** with
wasm32 (`size_t`/`void*` are 4 bytes). P4.4 freezes the contract used by
`?wasm=1` demo glue (P4.5).

## Decision

### 1. Heap exports (P4.3)

`webmap_wasm_alloc` / `webmap_wasm_free` / `webmap_wasm_reset_arena` and heap
stats remain as in ADR-025.

### 2. ABI packing table

Export `webmap_wasm_abi_pack_ptr` → little-endian `webmap_abi_pack_t` (version 1)
built **for the module target**. Host reads this table at instantiate time and
must not hardcode host-native offsets.

Recorded **wasm32** values (clang-19, freestanding):

| Field | Value |
|-------|------:|
| `ptr_size` / `size_t_size` | 4 |
| `sizeof(webmap_vertex_t)` | 12 |
| `sizeof(webmap_tile_id_t)` | 12 (`z@0`, `x@4`, `y@8`) |
| `sizeof(webmap_gpu_layer_t)` | 92 |
| layer `vertices` / `vertex_count` / `indices` / `index_count` | 0 / 4 / 8 / 12 |
| layer `kind` / `feature_class` / `name` / `extent` | 16 / 20 / 24 / 88 |
| `sizeof(webmap_config_t)` | 16 (4× `size_t`) |

### 3. Flat layer view (preferred host path)

`webmap_wasm_get_layer(ctx, z, x, y, i, out)` fills `webmap_wasm_layer_view_t`:

- `vertices_ptr`, `indices_ptr` as **u32 linear-memory offsets**
- counts/kind/extent as u32
- `name[64]`

Hosts should prefer this over parsing `webmap_gpu_layer_t` in JS.

### 4. Staging slab

Allocate one reusable slab: `staging = webmap_wasm_alloc(max_tile_bytes)` at
startup; `HEAPU8.set(tileBytes, staging)` per fetch; grow only if a tile
exceeds capacity. Do not rely on free between tiles for correctness (free-list
works after P4.3, but overwrite is simpler for staging).

### 5. After `memory.grow`

Re-create TypedArray views on `memory.buffer` (old buffers detach).

## Consequences

- Demo `demo/display/wasm_host.js` implements this contract.
- CI records wasm32 packing via module export (and optional native contrast test).

## Alternatives considered

| Option | Why not |
|--------|---------|
| Only host-native offsetof tests | Silently wrong for wasm32 |
| JSON layout file checked in | Drift without compile-time truth |
| Always re-instantiate module per tile | Too slow |
