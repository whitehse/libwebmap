# Path index package

Precomputed **optical fiber path** index for host path-trace UI (ADR-017
design). Produced by Tier B `tools/export_path_index.py` from Tier A
`fiber_paths` / `fiber_path_hops` tables (after `trace_fiber_paths.py`).

The browser **does not** walk connectivity graphs. It looks up `cable_guid`
(from `.fmap` v3 picks) → path ids → highlight polyline.

## Layout (`path_index_format`: 1)

Under a fiber package root (e.g. `demo/fiber_data/`):

```
path_index/
  meta.json
  cable_to_paths.json    # { "<uuid>": [path_id, …], … }
  paths.jsonl            # one JSON object per line
path_index.sqlite          # optional offline dual emit
```

Manifest fields (see [data-packages.md](data-packages.md)):

```json
{
  "path_index": "path_index/",
  "path_index_format": 1,
  "path_index_files": {
    "meta": "path_index/meta.json",
    "cable_to_paths": "path_index/cable_to_paths.json",
    "paths": "path_index/paths.jsonl"
  },
  "path_index_sqlite": "path_index.sqlite"
}
```

## Geometry

| Stage | CRS |
|-------|-----|
| `fiber_paths.geom_wkb` (ECOEC today) | Plain ISO WKB MultiLineString/LineString in **EPSG:2267** (US survey feet) |
| Package `lonlat` | **EPSG:4326** WGS84 degrees |

Exporter inverse-projects with the same Oklahoma North parameters as
`fiber2features`. Use `--wgs84-input` when Tier A already emits WGS84 WKB.

## Browser files

### `meta.json`

| Field | Meaning |
|-------|---------|
| `path_index_format` | `1` |
| `path_count` | Number of paths in this package |
| `hop_count` | Total hop records exported |
| `cable_count` | Distinct cables in `cable_to_paths` |
| `crs` | Always `EPSG:4326` for package polylines |
| `source_crs` | Design-DB geom CRS before conversion |
| `max_hop_count` | Max hops on any path |
| `generated_at` | ISO-8601 UTC |

### `cable_to_paths.json`

Map of **lowercased** full UUID string → array of `path_id` integers.
Built from `fiber_path_hops` where `hop_kind='cable'`, plus start/end cables.

### `paths.jsonl`

One object per path:

```json
{
  "path_id": 42,
  "start": { "cable_guid": "…", "fiber": 6 },
  "end": { "cable_guid": "…", "fiber": 6 },
  "end_kind": "drop",
  "hop_count": 12,
  "total_loss_db": -21.4,
  "has_drop": 1,
  "lonlat": [[-95.99, 36.12], [-95.98, 36.11]],
  "hops": [
    { "seq": 0, "kind": "cable", "cable_guid": "…", "fiber": 6 },
    {
      "seq": 1,
      "kind": "equipment",
      "sp_guid": "…",
      "station_id": "79-11-38",
      "port_name": "Pass Through",
      "split_db": -0.2
    }
  ]
}
```

Caps at export: ≤256 hops/path, ≤50 000 vertices on a single path polyline.

## ECOEC scale (reference)

On `fiber_design_test.sqlite` (sample plant):

| Metric | Value |
|--------|-------|
| Paths | ~21 361 |
| Hops | ~73 805 |
| Browser JSON estimate | ~12–20 MB uncompressed |

Do **not** emit one file per path (inode storm on static hosts).

## Tooling

```bash
# Fail-closed if fiber_paths missing/empty
python3 tools/export_path_index.py "$FIBER_DESIGN_DB" -o demo/fiber_data

# Synthetic unit test
python3 tools/export_path_index.py --self-test

# Package recipe also runs this when paths exist
FIBER_DESIGN_DB=… ./tools/build_fiber_package.sh
```

## Host load strategy (PR8)

1. Fetch `meta.json` + `cable_to_paths.json` when enabling path trace.
2. On first cable pick, fetch `paths.jsonl` once and build `Map<path_id, obj>`.
3. Cap candidate list at 32 paths per cable.

## Related

- [fmap.md](fmap.md) — cable GUID on v3 lines is the join key  
- [fiber-design-input.md](fiber-design-input.md) — `fiber_paths` tables  
- Design: [data-sources-display-separation.md](../designs/data-sources-display-separation.md) §6.4
