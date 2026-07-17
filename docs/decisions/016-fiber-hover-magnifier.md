# ADR-016: Fiber hover magnifier + compact splice detail

## Status

Accepted

## Date

2026-07-16

## Context

Operators need a quick, on-map view of tap ports, strand identity, and which
fibers splice between cables at a splicepoint — without leaving the map for a
full HTML diagram. Full `splice_diagrams/*.html` files average tens of KB and
encode topology as pre-rendered markup plus long-haul path graphs, which is a
poor fit for a 500 ms hover lens.

`.fmap` tiles correctly stay **geometry + coarse attributes** only (ADR-015).
Strand-level connectivity already lives in `fiber_design.sqlite`
(`ports`, `connections`, `cable_at_splice`, `equipment`).

## Decision

1. **Host-only interaction** in `demo/display/`: dwell (~500 ms) → Canvas2D
   magnifying-glass lens over the feature; click still opens the full diagram.
2. **Compact per-SP JSON** under `fiber_data/splice_detail/<guid>.json`,
   produced by `tools/export_splice_detail.py` from `fiber_design.sqlite`.
3. **Lazy fetch + cache** of detail when a tap/splice magnifier opens; fmap-only
   content (ports, colors, cable size) always works if detail is missing.
4. **Drop vs mainline** is a first-class visual distinction in schematics
   (dashed / warmer accents for drops).
5. No change to libwebmap C/WASM public API or `.fmap` v2 layout for v1.

## Consequences

- Demo depends on an extra export step when regenerating fiber data.
- ~one small JSON file per mapped splicepoint (lazy loaded; not packed into tiles).
- Schematic topology should stay aligned with `splice_diagram` pair logic;
  golden checks against known SPs are recommended when the exporter changes.

## Alternatives considered

| Option | Why not (for v1) |
|--------|------------------|
| Parse HTML on hover | Large payloads; brittle DOM/JSON hybrid |
| Embed connectivity in `.fmap` | Tile bloat; duplicates SPs across zooms |
| sql.js + single detail DB | Heavier host dependency for the demo |
| iframe full diagram | Not a “magnifier”; poor for dense maps |
