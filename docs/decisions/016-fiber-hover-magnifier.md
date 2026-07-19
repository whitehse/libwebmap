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

1. **Host-only interaction** in `demo/display/`: **click/tap** a splice or tap
   opens a Canvas2D magnifying-glass lens centered on that feature. The glass
   is an **exploratory meet-point view** for techs/office staff (not a splicer
   sheet):
   - Cables are laid out by **true geographic approach** (`approach_deg`: 0=N,
     90=E — not snapped to 45°/90°), from splice_detail v2 and/or `.fmap`
     geometry.
   - **Wheel / pinch** zooms the schematic world under the glass; drag pans in
     **inspect** mode. **Long-press** (or Space) toggles **navigate** mode so
     the glass focus can be dragged along the plant and adopt nearby SPs.
   - Highlight a strand color dot → that fiber **and its fuse-paired peer** on
     the other span (orthogonal splice bridge).
   - Click a fiber chip → **path-trace** that strand via `path_index`; double-
     click / long-press SP / Alt-click opens the full HTML diagram for splicers.
2. **Compact per-SP JSON** under `fiber_data/splice_detail/<guid>.json`,
   produced by `tools/export_splice_detail.py` from `fiber_design.sqlite`.
3. **Lazy fetch + cache** of detail when a tap/splice magnifier opens; fmap-only
   content (ports, colors, cable size) always works if detail is missing.
4. **Drop vs mainline** is a first-class visual distinction in schematics
   (dashed / warmer accents for drops).
5. No change to libwebmap C/WASM public API or `.fmap` layout for this ADR.

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
