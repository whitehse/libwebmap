# `.fmap` — fiber map feature tiles

**Normative home for the `.fmap` binary layout.** Writer:
`tools/fiber2features/` (CMake target `fiber2features`). Browser parse:
`demo/display/fiber_fmap.js`.

`.fmap` holds **data only** (ADR-015): geometry + attributes. No pixel radii,
n-gons, or line extrusion — the host styles and tessellates.

## Header (little-endian)

| Offset | Type | Field |
|--------|------|-------|
| 0 | u32 | magic `0x50414D46` (`'FMAP'`) |
| 4 | u32 | **version** (`1`, `2`, or planned `3`) |
| 8 | u8 | tile `z` |
| 9–11 | u8[3] | pad |
| 12 | u32 | tile `x` |
| 16 | u32 | tile `y` |
| 20 | u32 | `extent` (default `4096`) |
| 24 | u32 | `n_cables` |
| 28 | u32 | `n_drops` |
| 32 | u32 | `n_taps` |
| 36 | u32 | `n_splices` (**version ≥ 2 only**; header ends at 36 for v1) |

Payload order after header: **cables**, **drops**, **taps**, **splices**
(v2+).

Coordinates for lines and points are **tile-local** floats in
`[0, extent]` (same space as MVT / `.wmap` basemap tiles).

RGBA packing matches the rest of libwebmap host code: packed `u32` used as
`0xAABBGGRR` convenience colors (strand/tube/span colors as data attributes).

## Line records (cables and drops)

### Version 1 and 2 (current)

```
n_pts   u16
size    u16      # fiber count / cable size attribute
rgba    u32
pts[n_pts] { float x, float y }
```

**No plant cable GUID** on the line record. Joining a pick to optical paths is
not possible from tile bytes alone (see v3).

### Version 3 (planned — path-trace join key)

```
n_pts       u16
size        u16
rgba        u32
cable_guid  u8[16]   # binary UUID; all-zero = missing
pts[n_pts] { float x, float y }
```

+16 bytes per cable/drop line vs v2. Taps/splices unchanged. Writers must
`SELECT` cable `guid` into the emit path (not only `map_cables` SQLite).
Parsers dual-support v2 (empty guid) and v3.

## Tap records

### Version 1

```
float x, y
ports       u8
pad[3]
strand_rgba u32
tube_rgba   u32
```
(20 bytes)

### Version 2+

```
float x, y
ports       u8
pad[3]
strand_rgba u32
tube_rgba   u32
sp_guid     u8[16]   # splicepoint GUID for diagram / detail link
```
(36 bytes)

All-zero GUID is treated as missing.

## Splice records (version ≥ 2)

Non-tap splicepoints only (taps are not duplicated here):

```
float x, y
rgba    u32
sp_guid u8[16]
```
(28 bytes)

## Version summary

| Version | Lines | Taps | Splices | Notes |
|---------|-------|------|---------|-------|
| 1 | no GUID | no `sp_guid` | none | Legacy |
| **2** | no GUID | + `sp_guid` | + section | **Current demo / fiber2features** |
| **3** | + `cable_guid[16]` | same as v2 | same as v2 | Planned for path index join |

## Related package artifacts

| Artifact | Role |
|----------|------|
| `features.sqlite` | `map_cables` / `map_taps` / `map_splices` (see schema_map; offline) |
| `diagram_index.json` | splicepoint GUID → HTML basename |
| `splice_detail/<guid>.json` | Compact magnifier connectivity (ADR-016) |
| `path_index/` | Planned cable→path lookup (design doc) |

## Host modules

| Module | Role |
|--------|------|
| `demo/display/fiber_fmap.js` | Decode `.fmap` → JS objects |
| `demo/display/fiber_layer.js` | WebGPU lines, Canvas symbols, pick |
| `demo/display/fiber_style.js` | Paint policy only |

## Related docs

- [data-packages.md](data-packages.md) — manifests and version fields
- [fiber-design-input.md](fiber-design-input.md) — design DB the writer reads
- [ADR-015](../decisions/015-fiber-data-display-split.md) — data vs display
- [guides/fiber-map-data.md](../guides/fiber-map-data.md) — pipeline overview
