# ADR-026: WASM basemap parse default (P4.6 → P4.13)

## Status

**Superseded in part by P4.13** — default is now **auto WASM decode-and-drop**
with JS fallback. Historical opt-in-only decision retained below for context.

## Date

2026-07-18 (P4.6) · 2026-07-18 (P4.13 update)

## Context

P4.3–P4.5 delivered freestanding free-list reclaim, host ABI, and a working
`?wasm=1` basemap decode path. Program design forbade default-on while the WASM
path **retained tiles in linear memory** and **copied** geometry into JS for
GPU upload (dual pyramid residency).

P4.13 adds `webmap_drop_tile` and a host **decode-and-drop** path: load → extract
layers to host buffers for extrusion → drop C cache entry. Steady-state C
`tile_count` is 0; only staging + free-list overhead remain. Linear memory
import is reduced (8 MiB initial). Headless gate in
`tools/compare_wasm_parse.mjs` re-evaluates default-on.

## Decision

### P4.13 (current)

1. **Default mode = `auto`**: try freestanding WASM decode-and-drop; on failure
   fall back to pure JS (`wmap_parse.js`).  
2. **`?wasm=0`** forces JS. **`?wasm=1`** forces WASM attempt (still falls back
   to JS if the module fails to load).  
3. Host uses `decodeAndDrop: true` and `max_tiles=2` for basemap decode — the
   browser `basemapCache` / GPU buffers own long-lived residency (ADR-014).  
4. Gate doc: [wasm-default-on-gate.md](../guides/wasm-default-on-gate.md).  
5. Snapshots still record `parse_path` (`js` | `wasm`).

### P4.6 (historical)

1. Default basemap parse = pure JS.  
2. WASM parse = opt-in via `?wasm=1` only.  
3. Re-evaluate under P4.13 when reduced-copy / drop path exists.

## Consequences

- Cold start may instantiate `webmap.wasm` without a query param.  
- Operators can force JS for A/B or constrained environments (`?wasm=0`).  
- Host line extrusion still needs a **single** host-side geometry copy; that
  matches the JS parse path’s temporary ArrayBuffers (not dual pyramid).

## Alternatives considered

| Option | Why not |
|--------|---------|
| Keep opt-in forever | Leaves faster decode unused after gate green |
| Zero-copy WebGPU map from linear memory | Not required once drop eliminates dual cache; extrusion still needs host buffers |
| Default retain-cache WASM | Fails memory gate (dual residency) |

## Related

- [ADR-024](024-wasm-host-contract.md), [ADR-025](025-wasm-freelist-heap.md)
- [guides/wasm-default-on-gate.md](../guides/wasm-default-on-gate.md)
