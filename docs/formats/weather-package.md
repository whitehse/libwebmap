# Weather / wind overlay package

**Schema-only contract** for future weather and wind alerts on the status map
(ADR-017 Tier A/B → host overlays). No NetCDF/GRIB ingest in libwebmap core.
The C library remains syscall-free; the host fetches packages and calls
`webmap_upsert_overlay`.

Package layout follows [data-packages.md](data-packages.md) (`kind: "weather"`).

## Goals

| In scope (v1 contract) | Out of scope |
|------------------------|--------------|
| Alert polygons / lines / points as GeoJSON-like features | Network fetch inside C core |
| Map `status` → `webmap_status_t` + `webmap_status_rgba` | Full weather model grids in `.wmap` |
| Optional raster stub for host-only wind fields | Wind barb symbols (deferred) |
| Fixture + optional host stub loader | NWS/NOAA API client in this repo |

## Package shape (`format_version`: 1)

```json
{
  "kind": "weather",
  "format_version": 1,
  "name": "sample_alerts",
  "source": {
    "adapter": "nws_forecast",
    "label": "sample fixture",
    "retrieved_at": "2026-07-17T12:00:00Z"
  },
  "crs": "EPSG:4326",
  "features": [ /* see below */ ],
  "raster": null
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `kind` | yes | `"weather"` |
| `format_version` | yes | `1` |
| `source.adapter` | recommended | e.g. `nws_forecast`, `manual`, `synthetic` |
| `source.retrieved_at` | recommended | ISO-8601 when the feed was pulled |
| `crs` | yes | Feature coordinates; default **EPSG:4326** lon/lat |
| `features` | yes | Array of overlay feature objects |
| `raster` | no | Host-only wind/field texture stub (see below) |

## Feature object

```json
{
  "id": "ice-zone-1",
  "class": "alert",
  "status": "degraded",
  "geom": {
    "type": "Polygon",
    "coordinates": [[[-96.0, 35.5], [-95.5, 35.5], [-95.5, 35.9], [-96.0, 35.9], [-96.0, 35.5]]]
  },
  "props": {
    "hazard": "ice",
    "severity": "moderate",
    "valid_until": "2026-07-18T00:00:00Z",
    "headline": "Ice accumulation possible"
  }
}
```

| Field | Type | Notes |
|-------|------|-------|
| `id` | string | Stable feature id for upsert/remove |
| `class` | string | `"alert"` maps to `WEBMAP_CLASS_ALERT` |
| `status` | string | See status table |
| `geom` | GeoJSON geometry | WGS84 unless package `crs` says otherwise |
| `props` | object | Free-form; host may map `severity` → status if `status` omitted |

### Host mapping → `webmap_overlay_desc_t`

| Package geometry | Overlay kind | Class | Notes |
|------------------|--------------|-------|-------|
| GeoJSON `Polygon` / `MultiPolygon` | FILL | `WEBMAP_CLASS_ALERT` | Ice / flood / watch zones |
| GeoJSON `LineString` / `MultiLineString` | LINE | `WEBMAP_CLASS_ALERT` | Corridor / path alerts |
| GeoJSON `Point` / `MultiPoint` | POINT | `WEBMAP_CLASS_ALERT` | Station / spot alerts |
| Gridded wind | **not** via overlay API in v1 | — | Use `raster` for host texture |
| Wind barbs | deferred | — | Host symbol layer later |

Ring winding: follow GeoJSON (exterior CCW recommended). Host may reverse if
fill winding fails.

### Status strings → `webmap_status_t`

| Package `status` | Enum | Typical use |
|------------------|------|-------------|
| `unknown` | `WEBMAP_STATUS_UNKNOWN` | Missing / unclear |
| `ok` | `WEBMAP_STATUS_OK` | Clear / advisory only |
| `degraded` | `WEBMAP_STATUS_DEGRADED` | Watch / moderate hazard |
| `down` | `WEBMAP_STATUS_DOWN` | Warning / severe |
| `maint` | `WEBMAP_STATUS_MAINT` | Planned / test |

Colors: `webmap_status_rgba(status)`. Host may override per hazard type.

Optional mapping from `props.severity` when `status` is absent:

| `props.severity` | Default status |
|------------------|----------------|
| `minor` / `low` | `ok` |
| `moderate` / `medium` | `degraded` |
| `severe` / `extreme` / `high` | `down` |
| other / missing | `unknown` |

## Raster stub (host-only)

For gridded wind or radar-like fields **without** changing the C core:

```json
"raster": {
  "url": "./wind_u_v.png",
  "crs": "EPSG:3857",
  "bounds": [-10700000, 4200000, -10600000, 4300000],
  "encoding": "rg_uv",
  "units": "m_s",
  "valid_at": "2026-07-17T12:00:00Z"
}
```

| Field | Notes |
|-------|-------|
| `url` | Relative to package root or absolute HTTPS (host fetch) |
| `crs` | Usually EPSG:3857 for slippy-map aligned textures |
| `bounds` | `[west, south, east, north]` in `crs` units |
| `encoding` | Host convention (e.g. `rg_uv`, `rgba8`) — not interpreted by libwebmap |
| `units` | Documentation for host shaders |

libwebmap does **not** decode rasters. The host may draw them as a WebGPU
texture under/over basemap layers.

## Ingest boundary (Tier A / B)

```
NWS / model / manual feed  (Tier A adapter — future)
        │
        ▼
  weather package JSON     (this format)
        │
        ▼
  host loader → webmap_upsert_overlay  (Tier C host)
```

Recommended adapter name examples: `nws_forecast`, `nws_alerts`, `gfs_wind`,
`manual_geojson`. Bake tools (if any) live outside the C library, same as
fiber/basemap Tier B tools.

## Fixture

| Path | Content |
|------|---------|
| [fixtures/weather/sample_alerts.json](../../fixtures/weather/sample_alerts.json) | One ice polygon (degraded) + one station point (down) |

## Optional host stub

A future demo helper may:

1. `fetch("./weather/sample_alerts.json")`
2. For each feature, fill `webmap_overlay_desc_t` (or host-side GPU mesh)
3. Call `webmap_upsert_overlay` / rebuild overlay GPU buffers

No such loader is required for the contract to be useful. Do not block core
releases on weather UI.

## Related

- [data-packages.md](data-packages.md) — common package versioning  
- [ADR-017](../decisions/017-three-tier-data-boundary.md) — weather as overlay packages  
- [ADR-014](../decisions/014-plumbing-vs-host-renderer.md) — host owns device / I/O  
- `include/webmap.h` — `WEBMAP_CLASS_ALERT`, `webmap_status_t`, overlays  
