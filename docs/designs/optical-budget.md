# Optical budget & light direction (plan)

| Field | Value |
|-------|-------|
| **Status** | Draft — partial implementation in demo |
| **Date** | 2026-07-18 |

## Goals

1. Know **which way light travels** on a traced optical path.
2. Show **aggregate and hop-by-hop loss** for office / tech path inspection.
3. Later: estimate loss from **fiber length**, **fusion splices**, and **tap /
   splitter catalog values** with explicit assumptions.

## What exists today (demo)

| Source | Content |
|--------|---------|
| `path_index` paths | `start` / `end`, `total_loss_db`, ordered `hops` |
| Equipment hops | `port_name`, `port_name_type`, `split_db` (design DB) |
| `splice_detail` | Tap `loss_db`, links `ingress` / `egress` / `drop` / `fuse` |

**Light direction (v1):** path walk starts at the plant / feeder side. Demo
treats `path.start` as the **source** and hop order as **source → end**.

**Loss (v1):** sum of equipment `split_db` along hops (plus exported
`total_loss_db`). Cable hops contribute **0 dB** until a distance model is
added. UI: path list + hop budget strip when a path is selected.

**Tap through (v1 magnifier):** `ingress` + `egress` drawn as a distinct
through-tap path (IN → PT) separate from cable↔cable fuse splices; drops
shown with catalog drop loss.

## Planned model (not fully implemented)

```
L_total ≈ L_fiber + L_splice + L_equipment
```

| Term | Plan | Data needed |
|------|------|-------------|
| **L_fiber** | α × length_km | Cable geometry length (package or design DB); α e.g. 0.35 dB/km @1310, 0.22 @1550 (config) |
| **L_splice** | n_fuse × L_fuse_typ | Count fuse hops / connections; default ~0.05–0.1 dB |
| **L_equipment** | Σ split_db | Already in path hops (tap PT, drop, splitters) |

### Direction from taps

Asymmetric tap values encode direction:

- **Input** port: upstream (toward source)
- **Pass Through**: continue mainline (small split)
- **Drop**: customer leg (large negative dB, e.g. −13.66)

On a path, encountering `Input` then later `Pass Through` / `Drop` at the same
SP confirms source→sink order. If walks are ever reversed, re-root using the
first high-loss **Drop** as sink-side.

### Visualization backlog

- [x] Path list total loss + hop budget when selected  
- [x] Magnifier: through-tap strand distinct from fuse  
- [x] Source label on path budget  
- [ ] Color polyline by cumulative loss along path  
- [ ] Distance attenuation in exporter or host estimator  
- [ ] Configurable α, splice default, wavelength  
- [ ] Power-in assumption → estimated receive level (dBm)  

## Non-goals (v1)

- OTDR accuracy or as-built measured loss  
- Live telemetry (netforensics) join  
- Replacing full HTML splice diagram field sheets  

## Implementation touchpoints

| Piece | Location |
|-------|----------|
| Budget math | `demo/display/optical_budget.js` |
| Path UI | `demo/display/fiber_trace.js` |
| Tap through draw | `demo/display/fiber_schematic.js` |
| Path package | `docs/formats/path-index.md` |
