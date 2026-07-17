# Data directory

## GeoFabrik experimental vector tiles (Oklahoma)

| File / tree | Description |
|-------------|-------------|
| `oklahoma-shortbread-1.0.mbtiles` | Full-state Shortbread package from [GeoFabrik Oklahoma](https://download.geofabrik.de/north-america/us/oklahoma.html) (~175 MB) |
| `oklahoma_counties_pbf/` | Extracted MVT for nine counties, zooms 8–12 (~10 MB) |
| `REGION.txt` (inside pbf tree) | Bbox, county list, license note |

### Counties (memory-limited experiment)

Tulsa, Wagoner, Okmulgee, Creek, Okfuskee, McIntosh, Muskogee, Seminole, Lincoln

BBox W/S/E/N: `-97.15, 34.95, -95.05, 36.35`

### Re-extract / bake package

```bash
python3 tools/basemap_pipeline/extract_region.py
./tools/basemap_pipeline/build_package.sh   # → demo/basemap/
# wrappers: tools/extract_oklahoma_counties.py, tools/prepare_demo_tiles.sh
```

License: **ODbL 1.0** — OpenStreetMap contributors, Geofabrik GmbH.
