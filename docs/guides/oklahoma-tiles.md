# Oklahoma GeoFabrik Shortbread pipeline

Basemap **source adapter + package bake** for the nine-county ECOEC demo
(ADR-017). Tools live under `tools/basemap_pipeline/`. Package contract:
[docs/formats/data-packages.md](../formats/data-packages.md).

## Source

Experimental vector tile package from:

https://download.geofabrik.de/north-america/us/oklahoma.html  
→ `oklahoma-shortbread-1.0.mbtiles` (Shortbread schema, MVT in MBTiles)

License: **ODbL 1.0** (OpenStreetMap contributors, Geofabrik GmbH).

## County memory limit

Full state at high zoom exceeds typical browser/GPU budgets once expanded to
`.wmap`. For experimentation, clip to:

Tulsa, Wagoner, Okmulgee, Creek, Okfuskee, McIntosh, Muskogee, Seminole, Lincoln

Combined bbox (W,S,E,N): **-97.15, 34.95, -95.05, 36.35**

Default extract zooms **8–12** (~728 tiles, ~10 MB gzipped-off PBF).  
Demo defaults to **z8–12** (~44 MB `.wmap`); the host overzooms smoothly past z12
to ~z18 with extruded road/water widths.

## Commands

```bash
# 1) Download (≈175 MB)
curl -L -o data/oklahoma-shortbread-1.0.mbtiles \
  https://download.geofabrik.de/north-america/us/oklahoma-shortbread-1.0.mbtiles

# 2) Extract region PBF tree (Tier A/B extract)
python3 tools/basemap_pipeline/extract_region.py \
  --mbtiles data/oklahoma-shortbread-1.0.mbtiles \
  --out data/oklahoma_counties_pbf --zmin 8 --zmax 12

# 3) Build basemap package → demo/basemap/ (Tier B bake)
./tools/basemap_pipeline/build_package.sh
# lighter pack: ZMAX=10 ./tools/basemap_pipeline/build_package.sh

# 4) Optional: convert to a custom out dir without replacing demo
./build/gfvtile2wmap --dir data/oklahoma_counties_pbf \
  -o data/oklahoma_counties_wmap --zmin 8 --zmax 12 --quiet

# 5) Serve demo (Chrome/Edge with WebGPU)
python3 -m http.server -d demo 8765
```

Compatibility wrappers (same as steps 2–3):

```bash
python3 tools/extract_oklahoma_counties.py   # → extract_region.py
./tools/prepare_demo_tiles.sh                # → build_package.sh
```

Fixture for CI: `fixtures/tulsa_z10/238_401.pbf` (single Tulsa-area tile).

## Package manifest

`build_package.sh` writes `demo/basemap/manifest.json` with package fields:

| Field | Example |
|-------|---------|
| `kind` | `"basemap"` |
| `format_version` | `1` |
| `name` | `"oklahoma_counties"` |
| `source.adapter` | `"geofabrik_shortbread"` |
| `source.label` | `"GeoFabrik oklahoma-shortbread-1.0.mbtiles"` |
| `bbox` / `center` / `zoom` / `zmin` / `zmax` / `tiles` | unchanged semantics |
| `counties` | demo-only list |
| `crs_display` | `"EPSG:3857"` |

The demo host accepts both structured `source` and a legacy top-level string
`source` (see `normalizePackageManifest` in `demo/main.js`).

## Shortbread styling

The MVT decoder reads each feature’s `kind` tag (and other keys) and emits
`.wmap` layers named `layer/kind` (e.g. `streets/motorway`, `land/forest`).
Paint colors use a **VersaTiles Colorful**-inspired palette keyed by layer +
kind; the WebGPU demo also applies zoom-scaled road casings/widths by kind.

Schema reference: <https://shortbread-tiles.org/schema/1.0/>  
Style inspiration: [versatiles-style Colorful](https://github.com/versatiles-org/versatiles-style)
