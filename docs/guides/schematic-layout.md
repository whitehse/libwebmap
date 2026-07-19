# Schematic layout (WASM / C) — P4.10

Pure geometry for fiber meet-point schematics ([ADR-020](../decisions/020-schematic-layout-wasm.md)).
Interaction remains in the JS magnifier (ADR-016). **P4.11** wires the export
into the glass; this PR ships the C/WASM engine + tests.

## API

```c
#include "webmap_schematic.h"

size_t n = webmap_schematic_layout(
    json, json_len,
    /*cx*/ 0.f, /*cy*/ 0.f, /*radius*/ 168.f,
    out, out_cap);
/* n == 0 → failure */
```

WASM export name: `webmap_schematic_layout` (same signature; wasm32 pointers).

## Blob format (`WSCH` v1)

Little-endian packed structs (`include/webmap_schematic.h`):

| Section | Type | Count |
|---------|------|-------|
| Header | `webmap_schematic_header_t` | 1 |
| Cables | `webmap_schematic_cable_t` | `n_cables` |
| Fibers | `webmap_schematic_fiber_t` | `n_fibers` |
| Fuses | `webmap_schematic_fuse_t` | `n_fuses` |

| Header field | Meaning |
|--------------|---------|
| `magic` | `0x48435357` (`WSCH`) |
| `version` | `1` |
| `cx, cy, radius` | layout origin / approach ring input |
| `flags` bit0 | detail was a tap |

| Cable | Meaning |
|-------|---------|
| `guid` | 40-byte NUL-padded UUID string |
| `approach_deg` | snapped 0/45/…/315 |
| `ux, uy` | unit approach (0=N, 90=E; +y down) |
| `x, y` | hub on ring |
| `fiber_start` / `fiber_count` | slice into fiber table |

| Fiber | Meaning |
|-------|---------|
| `cable_index` | into cable table |
| `fiber_num` | 1-based strand |
| `x, y, chip_r` | chip position / radius |

| Fuse | Meaning |
|------|---------|
| `a_*/b_*` | endpoint cable index + fiber num |
| `ax,ay,bx,by` | chip positions |
| `mx,my` | bridge midpoint |

## Caps

| Limit | Value |
|-------|-------|
| Cables | 24 |
| Fiber chips | 512 |
| Fuses | 256 |
| Fibers per cable | 288 |

## Fixture

| Path | Content |
|------|---------|
| [fixtures/schematic/sample_tap.json](../../fixtures/schematic/sample_tap.json) | 3-cable tap, trimmed fuse links |

```bash
./build/webmap_schematic_layout   # ctest webmap_schematic_layout
```

## Host decoder + magnifier (P4.11)

`demo/display/schematic_layout.js`:

| Export | Role |
|--------|------|
| `decodeSchematicLayout` | Parse WSCH blob |
| `layoutViaWasm` | Call export with alloc/free |
| `createSchematicLayoutService` | Init wasm, cache layouts, auto/js/wasm modes |
| `parseSchematicQuery` | `?schematic=auto\|wasm\|js` |

The magnifier (`fiber_magnifier` → `paintMagnifierContent`) requests a layout
at the current body radius, then `drawGeoMeetSchematic` paints using precomputed
hub/chip coordinates. Interaction remains JS.

| Query | Effect |
|-------|--------|
| (default) / `?schematic=auto` | Prefer WASM; JS fallback |
| `?schematic=js` | Force JS geometry |
| `?schematic=wasm` | Require WASM export |

Glass footer shows `layout:wasm` when the export is used.

## Related

- [ADR-020](../decisions/020-schematic-layout-wasm.md)  
- [guides/wasm.md](wasm.md)  

