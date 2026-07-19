# Memory attribution guide (P4.0)

Program track **P4.0** from the edge platform design: measure and attribute demo
browser memory **before** defaulting the WASM tile path or freestanding free-list
work. Numbers are **outputs**, not gates invented up front.

Related:

- Design: `~/edge-platform-program-design.md` (Track 4)
- Demo harness: `demo/display/mem_stats.js`
- HUD: sidebar **Memory (P4.0)** (`?mem=0` to hide)
- WASM freestanding runtime: free-list heap (P4.3 / ADR-025); default-on gate: [wasm-default-on-gate.md](wasm-default-on-gate.md)
- Magnifier host-only: ADR-016

## Why this exists

Operators reported browser memory rising roughly **~85 MiB → ~500 MiB** after fiber
demo features. That figure is a **hypothesis** until split into:

| Layer | What it is | How we measure |
|-------|------------|----------------|
| **JS heap** | Parsed tiles, Maps, path_index, splice_detail, strings | Chrome `performance.memory.usedJSHeapSize` (+ optional Task Manager) |
| **GPU buffers** | WebGPU VERTEX/INDEX (`createBuffer` sizes) | Host counters in `mem_stats` |
| **WASM linear** | `WebAssembly.Memory` pages | `memory.buffer.byteLength` after `tryWasm` |
| **Process RSS** | Browser + GPU process total | OS / browser Task Manager only — **not** in harness |

GPU bytes **do not** sum with JS heap into process RSS. Accounted Σ is a **lower
bound** of intentional retainers, not a replacement for RSS.

## How to run the harness

```bash
# from libwebmap
python3 -m http.server -d demo 8765
# Chrome or Edge with WebGPU:
#   http://127.0.0.1:8765/
# Expand sidebar → Memory (P4.0)
# Copy snapshot JSON or Download
```

| Query | Effect |
|-------|--------|
| (default) | HUD on, 1.5 s refresh |
| `?mem=0` | HUD hidden (counters still run if modules call `memStats`) |
| `?max_tiles=256` | Host basemap + fiber LRU cap (default **256**) |
| `?max_tiles=0` | Unlimited host tile residency (debug; old pyramid-like) |
| `?wasm=1` | Basemap `.wmap` parse via freestanding WASM (P4.5); style/extrude still JS; **not default** (P4.6 / ADR-026) |

### P4.2 tile residency

- **C library:** `webmap_config_t.max_tiles` (default 256). On overflow, **LRU** slot is freed and `WEBMAP_EVENT_TILE_EVICTED` is emitted. Covered by `webmap_tile_eviction` ctest.
- **Demo host:** does **not** preload the full package. Viewport tiles are fetched on demand into `createTileCache` (`demo/display/tile_cache.js`). Status line shows `tiles base n/max · fiber n/max · evict k`.

After basemap + fiber packages load, log lines include:

- `mem basemap GPU …`
- `path_index ready · ~… JS`
- `mem accounted … · JS heap … (P4.0 harness …)`

### Capture protocol (fill baseline table)

1. Cold start: open tab, wait until **demo ready** in log.
2. **Idle after load** — note Accounted Σ, JS heap, basemap GPU, fiber GPU, path_index.
3. Pan/zoom across fiber for ~30 s (tile residency steady).
4. Open **5–10 magnifiers** (hover dwell) — watch `splice_detail` grow.
5. Click a cable → load full `paths.jsonl` if not yet loaded — watch `path_index JS`.
6. Download snapshot JSON; attach browser Task Manager “Memory footprint” if available.
7. Record browser version, OS, GPU, window size, packages (`fiber_data/manifest.json` name).

### Snapshot schema (`v: 1`)

```json
{
  "v": 1,
  "kind": "libwebmap_mem_snapshot",
  "t": "ISO-8601",
  "buckets": {
    "basemap_gpu": 0,
    "fiber_gpu": 0,
    "trace_gpu": 0,
    "path_index_js": 0,
    "splice_detail_js": 0,
    "fiber_geom_js": 0,
    "wasm_linear": 0,
    "js_heap": 0,
    "other_js": 0
  },
  "counts": {
    "basemap_tiles": 0,
    "fiber_tiles": 0,
    "basemap_gpu_meshes": 0,
    "fiber_gpu_meshes": 0,
    "splice_detail_entries": 0,
    "path_index_paths": 0,
    "path_index_cables": 0
  },
  "heap": { "available": true, "used": 0, "total": 0, "limit": 0 },
  "accounted_bytes": 0,
  "extra": { "fiber": {}, "path_trace": {} }
}
```

## Hot path inventory (impact until measured)

| Hot path | Today | Likely retain | Candidate follow-up |
|----------|-------|---------------|---------------------|
| `.wmap` parse → GPU | JS `parseWmap` + **LRU `tile_cache`** (P4.2) | Viewport lazy load; default **max_tiles=256** (`?max_tiles=N`, `0`=∞) | later `?wasm=1` |
| `.fmap` → GPU + hit geom | `fiber_layer` LRU cache + tileLines | Same max_tiles; pick geom drops on evict | C core: `max_tiles` LRU + `TILE_EVICTED` |
| `path_index` | lazy `paths.jsonl` after first trace | meta + cable_to_paths always; full paths on use | Cap / index-on-demand |
| `splice_detail` | lazy JSON per SP | unbounded Map until reload | LRU (with P4.2-style caps) |
| Magnifier/schematic | Canvas2D + detail JSON | detail cache + layout JS | ADR-020 layout → WASM later |
| WASM | ABI check + **free-list heap (P4.3)** | `webmap_wasm_heap_*` exports; reclaim on free | wire draw path (P4.4+) before default-on |
| Full HTML diagrams | not loaded until open | on disk ~1.2 GiB under `splice_diagrams/` | keep out of JS |

## Package disk footprint (demo tree, 2026-07-18)

Static sizes on disk (not JS heap). Useful for “what can ever be loaded”:

| Path | Approx size | Notes |
|------|-------------|-------|
| `demo/basemap/` | ~45 MiB | 728 `.wmap` tiles (demo region) |
| `demo/fiber_data/` | ~242 MiB | includes fmap + indexes + detail |
| `demo/fiber_data/path_index/paths.jsonl` | ~20 MiB | loaded into JS only on first path trace |
| `demo/fiber_data/path_index/cable_to_paths.json` | ~1.4 MiB | loaded with package |
| `demo/fiber_data/splice_detail/` | ~173 MiB | **34831** JSON files; **lazy** into cache |
| `demo/splice_diagrams/` | ~1.2 GiB | HTML; opened in new tab, not all in heap |
| Demo JS source | ~170 KiB | not a heap driver |

If every basemap+fiber tile is decoded and uploaded to GPU at once, **tens to
hundreds of MiB of GPU + inflated JS geometry** is expected—even without a
regression. The harness separates that from unbounded detail/path caches.

## Baseline table (fill after capture)

| Scenario | Accounted Σ | JS heap | basemap GPU | fiber GPU | path_index JS | splice_detail | WASM linear | Browser RSS |
|----------|-------------|---------|-------------|-----------|---------------|---------------|-------------|-------------|
| Cold idle after load | | | | | | | | |
| After pan/zoom 30 s | | | | | | | | |
| After 10 magnifier details | | | | | | | | |
| After path_index full load | | | | | | | | |

Leave cells blank until a Chrome/Edge run fills them. Commit filled rows under
`docs/guides/` or attach snapshot JSON to the PR that starts P4.1 budgets.

## Interpreting Chrome heap vs Accounted Σ

- **Accounted Σ** ≈ GPU counters + estimated JS retainers + WASM linear.  
  Estimates for JSON use a rough object-overhead model (`estimateJsonBytes`);
  they can overshoot or undershoot V8 heap.
- **JS heap** includes code, hidden shapes, short-lived parse buffers, and
  everything not bucketed—often **higher** than path_index + detail + geom.
- If **JS heap ≫ Accounted Σ**, look for untracked retainers (ArrayBuffers from
  fetch before discard, label canvas, diagram_index, leaked closures).
- If **RSS ≫ JS heap + GPU estimate**, look at GPU process, compositor, and
  other tabs; still use Task Manager “GPU memory” when available.

## Instrumentation map

| Module | What is counted |
|--------|-----------------|
| `demo/main.js` `createMesh` | `basemap_gpu` |
| `demo/display/fiber_layer.js` `createMesh` | `fiber_gpu`; geom Maps → `fiber_geom_js` |
| `demo/display/fiber_trace.js` | `path_index_js`, `trace_gpu` |
| `demo/display/fiber_magnifier.js` | `splice_detail_js` after each detail fetch |
| `tryWasm` | `wasm_linear` |

## Next PRs (do not reorder casually)

1. **P4.0** — this harness + guide (done when HUD + docs land).  
2. **P4.2** — tile eviction + `max_tiles` HUD (high ROI independent of WASM).  
3. **P4.3** — freestanding **free-list** reclaim + watermark (**done**; ADR-025).  
4. **P4.4–P4.5** — WASM host contract + `?wasm=1` basemap parse (**done**; ADR-024).  
5. **P4.6** — compare JS vs `?wasm=1` (**done**; default stays JS — [wasm-default-on-gate.md](wasm-default-on-gate.md)).

## Non-goals for P4.0

- No change to C/WASM public API.
- No freestanding free-list yet (P4.3).
- No eviction (P4.2).
- No fixed “must be under 200 MiB” gate.
