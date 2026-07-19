# ADR-027: Optional WebGPU glass lens chrome (P4.12)

## Status

Accepted (experiment / opt-in)

## Date

2026-07-18

## Context

P4.8 / ADR-021 established a host-only glass design language (CSS + Canvas
tokens). The fiber hover magnifier (ADR-016) draws its disc, rim, shadow, and
north tick in Canvas2D every frame. Program Track 4 **P4.12** calls for an
optional WebGPU “glass lens” material experiment without moving schematic
geometry or interaction into WGSL.

## Decision

1. **Opt-in only:** enable with demo query **`?glass_gpu=1`**. Default remains
   full Canvas chrome (no behavior change without the flag).
2. **Host-only:** `demo/display/glass_lens_gpu.js` owns a screen-space SDF
   pipeline (fullscreen triangle). No libwebmap C/WASM API.
3. **Chrome only:** GPU draws shadow, frosted fill, dual rim, soft specular,
   and north tick using `GLASS_LENS` token colors. Schematic content, hit tests,
   pan/zoom, and path-trace stay Canvas/JS.
4. **Compositing:** GPU lens is drawn at the **end of the map render pass**
   (under the labels canvas). Magnifier paint uses `chrome: "gpu"` to skip
   duplicate Canvas fill/rim/tick and keep a light content pad for readability.
5. Document usage in [guides/glass-ui.md](../guides/glass-ui.md).

## Consequences

- Operators can A/B Canvas vs GPU chrome without rebuilds.
- SDF rim quality and cost depend on GPU; mobile WebGPU may vary.
- Future: shared offscreen schematic texture or true frosted-glass blur sample
  of the map (out of scope for P4.12).

## Alternatives considered

| Option | Why not (for this PR) |
|--------|------------------------|
| Default-on GPU chrome | Experiment; Canvas path is battle-tested |
| Full schematic in WGSL | Huge port; interaction still needs hit lists |
| CSS backdrop-filter on a div | Cannot clip to map mercator/GPU easily; a11y blur issues |
| C core API for lens | UI chrome is host concern (ADR-014) |

## Related

- [ADR-016](016-fiber-hover-magnifier.md), [ADR-021](021-glass-ui-design-language.md)
- [guides/glass-ui.md](../guides/glass-ui.md)
