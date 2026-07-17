# DOMAIN.md — Web maps, vector tiles, rural fiber & electric status

## Product goal

A **performant web map** that:

1. Holds all or most **basemap** geometry needed for an operating area
2. Overlays **dynamic status** from other software in the home directory stack
3. Serves primarily as a **status map** for:
   - a rural **fiber-based broadband** network
   - a rural **electric** system  
   where most customers take **both** services

## Basemap & tiles

### Web Mercator / slippy map

Tiles are identified by `(z, x, y)` in the standard Web Mercator quadtree
(same as MapLibre / OpenStreetMap). Projection helpers convert WGS84 lon/lat
to EPSG:3857 meters and to tile ids.

### GeoFabrik experimental vector tiles

[GeoFabrik](https://www.geofabrik.de/) distributes OpenStreetMap extracts and
experimental **vector tile** products typically as **Mapbox Vector Tiles (MVT)**
in Protocol Buffer form (`.pbf`), often in a `{z}/{x}/{y}.pbf` layout or
similar packaging.

libwebmap does **not** stream MVT at runtime by default. The host tool
`gfvtile2wmap` converts MVT into **`.wmap`**: a compact, WebGPU-friendly
binary of pre-tessellated vertices and indices.

### OpenMapTiles / OSM layer names

Common layer names (`water`, `landuse`, `building`, `transportation`, …) map to
basemap colors in the converter. Layers whose names suggest `power` / `fiber` /
`telecom` are tagged with utility feature classes for emphasis.

## Runtime data held in the library

| Kind | Content |
|------|---------|
| **Basemap tiles** | `.wmap` layers: fill/line/point geometry in tile extent |
| **Overlays** | Dynamic features with stable ids, class, status, WGS84 geometry |

Design intent: keep the working set for a rural service territory **in memory**
so pan/zoom and status updates stay smooth without constant tile re-fetch.

## Fiber broadband domain

| Class | Meaning |
|-------|---------|
| `FIBER_SPAN` | Feeder or distribution fiber path (line) |
| `FIBER_NODE` | Hut, cabinet, splitter, OLT-side node (point) |
| `FIBER_CPE` | Customer ONT / gateway (point) |

Statuses: `ok`, `degraded`, `down`, `maint`, `unknown` — typically driven by
polling, IPFIX/path correlation, or NMS siblings.

## Electric domain

| Class | Meaning |
|-------|---------|
| `POWER_LINE` | Distribution primary/secondary (line) |
| `POWER_POLE` | Pole / structure (point) |
| `SUBSTATION` | Substation footprint or centroid |
| `OUTAGE_ZONE` | Polygon or hull of affected area |

## Shared customers

`CUSTOMER` and `ALERT` classes support join keys used by ops UIs: a household
with both electric and fiber can show stacked status without two maps.

## Weather / wind (overlay packages)

Weather is **not** a basemap tile layer and is **not** ingested inside the C
core. Future feeds produce a **weather package** (`kind: "weather"`) that the
host maps to dynamic overlays:

| Geometry | Overlay | Class |
|----------|---------|-------|
| Polygon / MultiPolygon | FILL | `WEBMAP_CLASS_ALERT` |
| LineString | LINE | `WEBMAP_CLASS_ALERT` |
| Point | POINT | `WEBMAP_CLASS_ALERT` |

Status strings (`ok` / `degraded` / `down` / …) map to `webmap_status_t` and
`webmap_status_rgba`. Gridded wind may be a host-only raster texture stub —
see [formats/weather-package.md](formats/weather-package.md) and
`fixtures/weather/sample_alerts.json`.

## WebGPU presentation

The library packs:

- `webmap_vertex_t`: `float x, y` + `uint32 rgba` (WGSL-friendly)
- index buffers for line lists / point lists / simple fan fills for overlays

Shaders, pipelines, and bind groups live in the host. This matches a
maplibre-rs-like split between map logic and GPU HAL.

## References

- Mapbox Vector Tile Specification 2.1
- GeoFabrik OSM extracts / vector tile experiments
- maplibre-rs architecture (WebGPU map renderer; structural inspiration only)
- EPSG:3857 Web Mercator
