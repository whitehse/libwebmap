# Fiber design intermediate input

**Contract for Tier B bake tools** that turn a normalized design database into
a fiber **map package** (`.fmap`, `features.sqlite`, splice detail, path index).

This is **not** a CrescentLink GeoPackage dump. Vendor extractors (Tier A) must
already have produced a SQLite database with the tables below. Today the only
supported producer is **crescentlink_export** (`export_fiber_design` + optional
`trace_fiber_paths.py`) for ECOEC-shaped data.

Until geometry is CRS-normalized in Tier A, Tier B remains coupled to the
**CrescentLink-normalized ECOEC** conventions documented here. Do **not** claim
multi-vendor readiness without satisfying the geometry contract.

Related: [ADR-017](../decisions/017-three-tier-data-boundary.md),
[data-packages.md](data-packages.md), [fmap.md](fmap.md).

## Supported producer label (v1)

| Field | Value |
|-------|-------|
| Package `source.adapter` | `crescentlink_normalized_ecoec` |
| Intermediate DB | `fiber_design.sqlite` (or `fiber_design_test.sqlite`) |
| Schema origin | `crescentlink_export/schema.sql` (+ `schema_paths.sql` for paths) |

## Geometry encoding and CRS

### Today (only supported path)

| Property | Value |
|----------|-------|
| Tables | `cables.geom`, `splicepoints.geom`, optional `equipment_disp.geom` |
| Encoding | **GeoPackageBinary** (`GP` header + flags + envelope + ISO WKB) **or** raw ISO WKB (Python export path) |
| CRS | **EPSG:2267** — NAD83 / Oklahoma North, **US survey feet** |
| Tier B behavior | `fiber2features` embeds inverse projection (`ok_north_*`) → WGS84 lon/lat, then Web Mercator tile math |

`fiber_paths.geom_wkb` (when present) is typically **plain WKB** MultiLineString
in the **same design CRS** (EPSG:2267 feet), not GPKG-wrapped. Path-index
export must inverse-project to WGS84 lon/lat before writing package polylines.

### Long-term contract (preferred)

| Property | Value |
|----------|-------|
| Encoding | Plain ISO WKB only (endian + type + coords) |
| CRS | **EPSG:4326** (WGS84 lon/lat degrees) for all design geom and path geom |
| `meta` keys | `geom_crs=EPSG:4326`, `geom_encoding=wkb` |
| Tier B | No state-plane inverse projection; tile from lon/lat only |

### Transition

1. **v1 (now):** Document ECOEC behavior; bake tools keep EPSG:2267 path;
   `source.adapter` = `crescentlink_normalized_ecoec`.
2. **v1.1:** Tier A rewrites geom to WGS84 WKB and sets `meta`.
3. **v1.2:** Tier B reads `meta.geom_crs`; if `EPSG:4326` + `wkb`, skip
   `ok_north_*`; missing meta defaults to legacy 2267 for one release, then
   hard-fail.

## Tables and columns Tier B uses

Minimum set actually queried by current / planned bake tools. Other design
columns may exist for splice HTML / ops and are out of scope here.

### Core connectivity (`schema.sql`)

| Table | Columns (minimum) | Used by |
|-------|-------------------|---------|
| `meta` | `key`, `value` | Recommended for CRS/encoding |
| `cables` | `guid`, `cable_size`, `geom` | `fiber2features` |
| `splicepoints` | `guid`, `station_id`, `geom` | `fiber2features`, diagrams |
| `equipment` | `guid`, `splicepoint_guid`, `is_tap`, `tap_ports`, `tap_loss_db` | features, splice_detail |
| `equipment_disp` | `guid`, `name`, `fiber_tube_color`, `fiber_strand_color`, optional `geom`, `out_*` colors | tap colors/names |
| `ports` | `parent_guid`, `parent_type`, `port_name_type`, `patch_guid`, `patch_number`, `split_db`, numbers/sides | drop detect, splice_detail |
| `connections` | from/to type+guid+number, `splicepoint_guid`, `split_db` | splice_detail |
| `cable_at_splice` | `splicepoint_guid`, `cable_guid` | optional / tools |

### Optical paths (`schema_paths.sql`, optional for paint)

| Table | Columns (minimum) | Used by |
|-------|-------------------|---------|
| `fiber_paths` | `path_id`, start/end cable+fiber, `end_kind`, `hop_count`, `total_loss_db`, `has_drop`, `geom_wkb` | `export_path_index` (planned) |
| `fiber_path_hops` | `path_id`, `seq`, `hop_kind`, `cable_guid`, `fiber_number`, equipment/SP fields | path index join |

Path walk itself stays in Tier A (`trace_fiber_paths.py`). Tier B only reads
these tables when present.

## Residual CrescentLink-shaped conventions (v1)

Documented so a tool move into libwebmap does not pretend full neutrality:

| Assumption | Today | Target |
|------------|-------|--------|
| Drop detection | `ports.port_name_type = 'drop'` → drop cable set | Same semantic column in intermediate |
| Tap identity | `equipment.is_tap` + `tap_ports`; colors from `equipment_disp` | Same tables or documented aliases |
| Diagram basename | Matches `splice_diagram` `sp_<station_or_guid>_<guid8>.html` rules | String attribute only; no live link to diagram binary |
| GUID text | Lowercased UUID strings in SQL; 16-byte binary in `.fmap` | Keep |

## Map package outputs (Tier B)

Produced **from** this intermediate (not from GPKG):

| Output | Producer |
|--------|----------|
| `{z}/{x}/{y}.fmap` | `fiber2features` |
| `features.sqlite` (`map_*` tables) | `fiber2features` |
| `manifest.json` | `fiber2features` |
| `diagram_index.json` | `fiber2features` |
| `splice_detail/<guid>.json` | libwebmap `tools/export_splice_detail.py` |
| `path_index/` | planned `export_path_index` |

See [data-packages.md](data-packages.md) and [fmap.md](fmap.md).

## Explicit non-inputs for Tier B

Tier B **must not** require:

- CrescentLink GeoPackage paths or layer names (`sdm_*_evw`, …)
- `xmlEquipment` XML blobs
- Absolute host paths hardcoded in manifests

Those remain Tier A concerns.

## Related source

**Tier A** (adapter tree, e.g. sibling `crescentlink_export/`):

- `schema.sql`, `schema_paths.sql`
- `export_fiber_design`, `trace_fiber_paths.py`

**Tier B** (this repo):

- `tools/schema/schema_map.sql`, `tools/fiber2features/`
- `tools/splice_diagram/` — HTML diagrams via CMake target `splice_diagrams`
  (`demo/splice_diagrams/`, optional via `diagrams_url`)
