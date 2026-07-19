# WASM default-on gate (P4.6 / P4.13)

## Decision (2026-07-18, updated P4.13)

**Demo basemap parse defaults to WASM decode-and-drop (`auto`)** when
`webmap.wasm` loads. Force JS with **`?wasm=0`**. Force WASM attempt with
**`?wasm=1`**.

P4.6 kept JS default until the dual-residency problem was fixed. P4.13 lands
`webmap_drop_tile` + host decode-and-drop so the C cache does not hold a second
copy of the basemap pyramid.

Related: ADR-024, ADR-025, ADR-026 (updated), P4.0 harness,
`tools/compare_wasm_parse.mjs`.

## Prerequisites

| # | Criterion | Status |
|---|-----------|--------|
| 1 | P4.0 measurement harness + attribution guide | **Done** |
| 2 | P4.2 host + C `max_tiles` eviction tests | **Done** |
| 3 | P4.3 freestanding free-list + watermark exports | **Done** |
| 4 | P4.4 packing / flat layer contract | **Done** |
| 5 | P4.5 `?wasm=1` basemap path | **Done** |
| 6 | Headless parse parity (payload/layers match JS) | **Done** |
| 7 | No dual C+JS pyramid residency | **Done** (P4.13 decode-and-drop) |
| 8 | Headless gate: errors=0, payload match, heap budget, speed | **Automated** via compare tool |
| 9 | Optional: true zero-copy GPU map from linear memory | Deferred (extrusion still host-side) |

## Headless parse compare

```bash
# from libwebmap repo root (uses decode-and-drop by default)
node tools/compare_wasm_parse.mjs --limit 40
node tools/compare_wasm_parse.mjs --limit 40 --json
# legacy dual-cache (should fail gate):
node tools/compare_wasm_parse.mjs --limit 12 --retain-cache
```

Latest machine-readable result: `docs/guides/p46-compare-latest.json`.

### Gate pass conditions (all)

1. `errors == 0` on both paths  
2. Output payload bytes and layer counts match  
3. Mean WASM parse time ≤ 1.15× JS  
4. Decode-and-drop: C `tile_count == 0` after sequential loads  
5. WASM heap used ≤ 3 MiB after loads  
6. Linear memory ≤ 12 MiB (soft; default import is 8 MiB)

## Product default (P4.13)

| Mode | Query | Behavior |
|------|-------|----------|
| **Default** | (none) or `?wasm=auto` | Try WASM decode-and-drop; JS on failure |
| Force WASM | `?wasm=1` | Same path; still falls back to JS if module fails |
| Force JS | `?wasm=0` | Pure `wmap_parse.js` |

## Browser A/B (optional)

1. `http://127.0.0.1:8765/?wasm=0` — JS  
2. `http://127.0.0.1:8765/` — WASM auto  

Compare Memory HUD `parse_path`, accounted Σ, and Task Manager RSS.

## Non-goals

- Not moving line extrusion into WASM (still host).  
- Not fiber `.fmap` WASM path (basemap only).  
- Not removing the JS parser (fallback + A/B).
