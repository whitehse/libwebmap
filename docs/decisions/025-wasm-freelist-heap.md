# ADR-025: Freestanding WASM free-list heap (P4.3)

## Status

Accepted

## Date

2026-07-18

## Context

The freestanding WASM runtime (ADR-009/010) originally used a **bump allocator**
with a no-op `free`. Tile load/evict cycles cannot reclaim linear memory under
that model; operator memory work (P4.0/P4.2) requires a reclaim strategy before
default-on WASM tile paths.

Program decision (edge platform design): **primary reclaim = free-list in
`webmap_wasm_rt` / `webmap_heap`**, with **module reload on watermark** as safety
net. Host-imported malloc is not primary.

## Decision

1. Implement a **boundary-tag free-list** allocator in `wasm/webmap_heap.c` with
   coalescing, used by freestanding `malloc`/`free`/`calloc`/`realloc`.
2. Export host-facing helpers (stable names):
   - `webmap_wasm_alloc` / `webmap_wasm_free`
   - `webmap_wasm_reset_arena` (full wipe; only when no live pointers)
   - `webmap_wasm_heap_used` / `_free_bytes` / `_capacity` / `_high_water`
   - `webmap_wasm_heap_over_watermark` / `webmap_wasm_heap_set_watermark`
3. Default watermark = **75% of current capacity**; host may lower/raise.
   When over watermark after tile churn, host should **reload the module**
   (or `reset_arena` only after destroying all C contexts).
4. Native unit tests simulate a linear arena (`tests/test_wasm_heap.c`) so
   freelist correctness does not require browser CI.

## Consequences

- Tile eviction in the C core can actually return memory to the freelist when
  running under WASM.
- Fragmentation remains possible; watermark + reload covers pathological cases.
- Bump-only docs are obsolete; `docs/guides/wasm.md` describes free-list.

## Alternatives considered

| Option | Why not primary |
|--------|-----------------|
| Keep bump + reload only | Works but thrashy; no fine-grained reclaim |
| Host-imported malloc | Valid under ADR-009; rejected as primary for ABI simplicity |
| Full dlmalloc port | Heavier than needed for map working sets |
