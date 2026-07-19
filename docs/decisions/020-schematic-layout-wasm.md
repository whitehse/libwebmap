# ADR-020: Magnifier schematic — pure layout in WASM (phase 1)

## Status

Accepted

## Date

2026-07-18

## Context

The fiber hover magnifier (ADR-016) computes meet-point geometry in JS
(`demo/display/fiber_schematic.js`): 45° approach snap, spoke collision,
strand columns, fuse bridges. Program design Track 4 **P4.10** moves **pure
layout** into freestanding WASM so JS keeps interaction only (dwell, pan,
zoom, Canvas paint). Full magnifier consumption is **P4.11**.

## Decision

1. **API** (`include/webmap_schematic.h`):
   ```c
   size_t webmap_schematic_layout(
       const uint8_t *json, size_t json_len,
       float cx, float cy, float radius,
       uint8_t *out, size_t out_cap);
   ```
2. **Input:** splice_detail JSON bytes (v1/v2). Minimal freestanding parser
   extracts `cables[]` (guid, approach_deg, is_drop, size), `links[]`
   (fuse endpoints), and tap flag — not a general JSON library.
3. **Output:** packed little-endian blob `WSCH` v1:
   - header → cable table → fiber chip table → fuse bridge table  
   - Coordinates in layout space (Canvas CSS-px convention when
     `cx/cy/radius` match the lens body).
4. **WASM export** (same name) via `wasm/webmap_wasm_entry.c`. No Emscripten.
5. **Caps** (fixed arrays): 24 cables, 512 chips, 256 fuses, 288 fibers/cable.
6. **Stays JS:** dwell timers, pointer hit-test, wheel zoom, pan, DOM/CSS
   chrome, TIA color paint, path-trace actions.
7. **P4.11 (done):** magnifier consumes the export via
   `createSchematicLayoutService` + `drawGeoMeetSchematic({ precomputed })`.
   Default **auto**: WASM when `webmap.wasm` loads; `?schematic=js` forces
   legacy JS geometry; `?schematic=wasm` requires the export.

## Consequences

- Layout algorithm is shared between native tests and `webmap.wasm`.
- Parser is intentionally incomplete (only fields needed for layout).
- Blob layout is part of the host contract; document in
  [guides/schematic-layout.md](../guides/schematic-layout.md).

## Alternatives considered

| Option | Why not |
|--------|---------|
| Full JSON library in freestanding | Size / alloc policy risk |
| Binary-only input (no JSON) | Forces host re-encode; design specifies JSON ptr |
| Move Canvas paint to WASM | Interaction stays JS (this ADR’s split) |

## Related

- [ADR-016](016-fiber-hover-magnifier.md), [ADR-009](009-no-emscripten.md)  
- Program design ADR-020 magnifier partition table  
