# ADR-022: Weather package host paint + transparency

## Status

Accepted

## Date

2026-07-18

## Context

The weather package schema (`docs/formats/weather-package.md`) and fixture
exist for alert polygons/lines/points mapped to `WEBMAP_CLASS_ALERT` and
`webmap_status_t`. Program design Track 4 **P4.7** requires fixture paint and
opacity in the demo host without pulling NWS clients or NetCDF into the C
core (ADR-004, ADR-017).

Raster wind fields are host-only textures; libwebmap does not decode them.

## Decision

1. **Host paint only** — `demo/display/weather_layer.js` loads package JSON,
   triangulates/extrudes geometry in JS, and issues WebGPU draws with the
   shared basemap vertex layout (`float2 xy + float2 normal + u32 rgba`).
2. **Status colors** match `webmap_status_rgba` (`0xAABBGGRR`). When `status`
   is omitted, `props.severity` maps minor→ok, moderate→degraded, severe→down.
3. **Opacity** is host policy: default **0.45**, adjustable via sidebar and
   `?weather_opacity=`; disable with `?weather=0`. Vertex alpha is honored
   (shader no longer clamps α ≥ 0.92).
4. **No C API change** for v1. Production hosts may later call
   `webmap_upsert_overlay` from the same package mapping; the demo does not
   require WASM for weather.
5. **Raster** fields in the package are logged as stubs; no texture pipeline
   in this ADR.

## Consequences

- Operators can verify alert overlays against Oklahoma basemap/fiber demos
  offline without edgehost NOTIFY (P4.9 / P1.12).
- Semi-transparent fills sit above basemap (~order 55) and under fiber
  (~order 80+).

## Alternatives considered

| Option | Why not |
|--------|---------|
| Build weather meshes only via C `webmap_build_overlay_gpu` in WASM | Extra ABI work; not needed for fixture paint |
| Full MapLibre style for weather | Out of scope for status-map alerts |
| Hard-coded colors per hazard | Status enum is the shared contract |

## Related

- [formats/weather-package.md](../formats/weather-package.md)
- [ADR-014](014-plumbing-vs-host-renderer.md), [ADR-017](017-three-tier-data-boundary.md)
- Program design Track 4 P4.7
