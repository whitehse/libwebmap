# ADR-018: Fiber path visual trace (host highlight)

## Status

Accepted

## Date

2026-07-17

## Context

Operators need to follow an individual optical fiber path across the map after
the three-tier data split (ADR-017). Optical connectivity is already walked
offline into `fiber_paths` / `fiber_path_hops`. `.fmap` v3 carries cable GUIDs
for join. Re-walking the graph in the browser or WASM core would violate the
host/core boundary and duplicate Tier A logic.

## Decision

1. **Precomputed path_index** (Tier B, `export_path_index.py`) is the only
   runtime source of path geometry and hop lists.
2. **Host UI** (`demo/display/fiber_trace.js`):
   - Click cable/drop → lookup `cable_guid` → path candidates (cap 32).
   - Single candidate auto-selects; multiple show a path list panel.
   - Tap/splice click still opens diagrams (unchanged); Esc / Clear clears trace.
3. **Highlight** is a host WebGPU line mesh (same extrude as fiber cables), not
   `webmap_upsert_overlay` for v1.
4. **Dim** non-selected fiber lines via uniform `fiber_dim` (default 1.0; 0.25
   while tracing). Basemap draws always use dim 1.0.
5. **No C/WASM API change** for v1 path trace.

## Consequences

- Packages without path_index still paint; path click logs “not available”.
- Packages without fmap v3 cable GUIDs cannot join picks to paths.
- Full plant path_index is multi-MB JSON; host loads `paths.jsonl` on first use.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Graph walk in browser from splice_detail | Incomplete graph; wrong tier |
| Bake all paths into tiles | Bloat; poor selection UX |
| `webmap_upsert_overlay` for highlight | Works later; host line path already matches fiber style |

## References

- Design: [data-sources-display-separation.md](../designs/data-sources-display-separation.md) §6
- [path-index.md](../formats/path-index.md) · [fmap.md](../formats/fmap.md) v3
