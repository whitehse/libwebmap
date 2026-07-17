# ADR-015: Fiber data / display split

## Status

Accepted

## Date

2026-07-16

## Context

Encoding display decisions (tap n-gon by port count, pixel radii, ports in
RGBA alpha) into export tools mixed **what the network is** with **how the map
paints it**. Tap symbols also broke when expanded through the line-width
WebGPU path.

## Decision

1. **Map feature tables** (`schema_map.sql`: `map_cables`, `map_taps`,
   `map_splices`) and **`.fmap` v2 tiles** hold geometry + attributes only
   (including splicepoint GUIDs for diagram links).
2. **Display** lives in the host (`demo/display/`): style stops, line
   tessellation, Canvas2D symbols (tap circles + non-tap splice hexagons),
   and click → splice diagram.
3. Optional future bake steps may pre-tessellate lines for speed; they still
   read feature tables/tiles, not re-encode port counts as shapes.

## Consequences

- `fiber2features` is the demo path for fiber data.
- `fiber2wmap` remains a legacy GPU bake tool.
- Taps render as screen-space circles with port digits; non-tap splicepoints
  as hexagons (enclosure); both open `splice_diagrams/` HTML on click.

## Alternatives considered

- Full MapLibre style JSON — deferred.
- Packing ports in alpha of `.wmap` points — rejected (opaque color conflict;
  conflates data with paint).
