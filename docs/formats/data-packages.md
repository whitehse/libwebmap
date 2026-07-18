# Data packages

On-disk **map data packages** are the boundary between Tier A/B producers and
Tier C display (ADR-017). A package is a directory with a `manifest.json` and
format-specific blobs (`.wmap`, `.fmap`, JSON indices, optional SQLite).

This document is **normative for package layout and versioning**. Tile bytes
are specified separately ([fmap.md](fmap.md), `.wmap` in
[ARCHITECTURE.md](../../ARCHITECTURE.md)). Intermediate design-DB inputs are
in [fiber-design-input.md](fiber-design-input.md).

## Served instances (demo)

```
demo/
  basemap/                     # kind = basemap
    manifest.json
    {z}/{x}/{y}.wmap
  fiber_data/                  # kind = fiber
    manifest.json
    features.sqlite            # offline / tools; not required in browser
    diagram_index.json
    {z}/{x}/{y}.fmap
    splice_detail/<guid>.json  # optional (ADR-016)
    path_index/                # optional (planned path trace)
      meta.json
      cable_to_paths.json
      paths.jsonl
  splice_diagrams/             # OPTIONAL HTML; generated real dir (gitignored)
```

Abstract layout is the same under any root; `demo/` is the package *instance*
the WebGPU host serves today.

## Version fields (do not conflate)

| Field | Versions | Bump when |
|-------|----------|-----------|
| `format_version` | Package **manifest schema** | New/removed/renamed top-level manifest keys or semantics |
| `fmap_version` | `.fmap` **tile bytes** | Line/point record layout (e.g. v2 → v3 cable GUID) |
| `path_index_format` | Path index files | JSONL / sqlite field changes |
| splice detail `v` | Per-file JSON | Compact detail shape (ADR-016) |

Host rules of thumb:

- Missing or lower `fmap_version` than expected: parse if supported; disable
  features that need newer fields (e.g. path join needs fmap v3 + path_index).
- Missing `path_index`: paint works; path trace stays off with a log/toast.
- Missing `splice_detail`: magnifier falls back to fmap-only (ADR-016).

## Common manifest fields (`format_version`: 1)

```json
{
  "kind": "basemap",
  "format_version": 1,
  "name": "oklahoma_counties",
  "source": {
    "adapter": "geofabrik_shortbread",
    "label": "GeoFabrik oklahoma-shortbread-1.0",
    "input_fingerprint": "sha256:…"
  },
  "crs_display": "EPSG:3857",
  "bbox": [-97.15, 34.95, -95.05, 36.35],
  "center": [-95.99, 36.15],
  "zoom": 10,
  "zmin": 8,
  "zmax": 12,
  "created_at": "2026-07-17T00:00:00Z",
  "tiles": [{ "z": 10, "x": 238, "y": 401 }]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `kind` | yes (new packages) | `"basemap"` \| `"fiber"` \| `"weather"` |
| `format_version` | yes (new packages) | Manifest schema version; start at `1` |
| `source.adapter` | recommended | Machine id for producer (e.g. `geofabrik_shortbread`, `crescentlink_normalized_ecoec`) |
| `source.label` | recommended | Human-readable source name |
| `source.input_fingerprint` | optional | Content hash of intermediate input (no absolute paths) |
| `bbox`, `center`, `zoom`, `zmin`, `zmax` | basemap yes | WGS84 lon/lat for bbox/center |
| `tiles` | basemap yes | List of `{z,x,y}` present in the tree |
| `counties` | optional | Demo basemap only |
| `name` | optional | Package instance name |
| `created_at` | optional | ISO-8601 |

### Legacy basemap manifests

Older manifests may use a top-level string:

```json
"source": "GeoFabrik oklahoma-shortbread-1.0.mbtiles"
```

Loaders **must** accept that form for one migration window and treat it as
`source.label` (`demo/main.js` `normalizePackageManifest`).  
`tools/basemap_pipeline/build_package.sh` writes structured `source` with
`adapter` + `label`.

**Bake tools must not write absolute filesystem paths** (e.g. `/home/…`) into
manifests by default. Use `source.label` and optional `input_fingerprint`.

## Fiber package (`kind`: `"fiber"`)

Additional fields:

```json
{
  "kind": "fiber",
  "format_version": 1,
  "format": "fmap",
  "fmap_version": 2,
  "name": "ecoec_sample",
  "source": {
    "adapter": "crescentlink_normalized_ecoec",
    "label": "fiber_design_test",
    "input_fingerprint": "sha256:…"
  },
  "tables": ["map_cables", "map_taps", "map_splices"],
  "features_sqlite": "features.sqlite",
  "path_index": "path_index/",
  "path_index_format": 1,
  "path_index_files": {
    "meta": "path_index/meta.json",
    "cable_to_paths": "path_index/cable_to_paths.json",
    "paths": "path_index/paths.jsonl"
  },
  "splice_detail_url": "./splice_detail/",
  "diagrams_url": "./splice_diagrams/",
  "diagram_index": "diagram_index.json",
  "features": {
    "cables": 39803,
    "drops": 16807,
    "taps": 10533,
    "splices": 24298,
    "paths": 21361
  },
  "zmin": 10,
  "zmax": 14,
  "tiles": [{ "z": 12, "x": 950, "y": 1610 }]
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `format` | recommended | `"fmap"` for the demo path |
| `fmap_version` | yes for fmap packages | Matches tile header version (see [fmap.md](fmap.md)) |
| `features_sqlite` | optional | Relative path; browser demo does not require it |
| `splice_detail_url` | optional | Relative to fiber package base (e.g. `./splice_detail/`) |
| `diagrams_url` | optional | **Page-relative** URL for HTML diagrams (demo often `./splice_diagrams/`). If null/missing, diagram click is a no-op |
| `diagram_index` | optional | GUID → HTML basename map |
| `path_index` / `path_index_format` / `path_index_files` | optional | [path-index.md](path-index.md); required for path-trace UI |
| `features` | optional | Counts for UI / sanity |
| `zmin` / `zmax` / `tiles` | recommended | Tile pyramid coverage |

### What the display needs

| Input | Paint | Path trace | Magnifier | Full HTML diagram |
|-------|-------|------------|-----------|-------------------|
| `.fmap` + fiber manifest | yes | fmap **v3** + path_index | partial | no |
| `path_index/` | no | **yes** | no | no |
| `splice_detail/` | no | no | full schematic | no |
| `diagrams_url` + HTML files | no | no | no | **yes** |
| `features.sqlite` | no (browser) | no | no | no |

Demo **must** run with basemap + fiber `.fmap` only. Diagrams, path_index, and
splice_detail are progressive enhancements (ADR-017).

## Weather package (`kind`: `"weather"`)

Schema + fixture: [weather-package.md](weather-package.md),
`fixtures/weather/sample_alerts.json`. Overlays use host
`webmap_upsert_overlay` + `WEBMAP_CLASS_ALERT`; not C-core tiles.

## Related

| Doc | Role |
|-----|------|
| [ADR-017](../decisions/017-three-tier-data-boundary.md) | Three-tier boundary |
| [fmap.md](fmap.md) | `.fmap` tile bytes |
| [fiber-design-input.md](fiber-design-input.md) | Intermediate design DB for bake tools |
| [guides/fiber-map-data.md](../guides/fiber-map-data.md) | Operator-oriented fiber pipeline |
| [design](../designs/data-sources-display-separation.md) | Full separation + path-trace plan |
