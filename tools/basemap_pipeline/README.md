# basemap_pipeline

Tier A/B tools that turn **GeoFabrik Shortbread** (MBTiles → MVT) into a
**basemap package** (`.wmap` + manifest) for libwebmap (ADR-017).

```
MBTiles (Shortbread)
        │  extract_region.py
        ▼
  {z}/{x}/{y}.pbf
        │  build_package.sh  →  gfvtile2wmap
        ▼
  package/  (e.g. demo/basemap/)
    manifest.json   kind=basemap, format_version=1
    {z}/{x}/{y}.wmap
```

## Commands

```bash
# 1) Extract region PBF (default: nine Oklahoma counties)
python3 tools/basemap_pipeline/extract_region.py \
  --mbtiles data/oklahoma-shortbread-1.0.mbtiles \
  --out data/oklahoma_counties_pbf --zmin 8 --zmax 12

# 2) Bake basemap package for the demo
./tools/basemap_pipeline/build_package.sh
# lighter: ZMAX=10 ./tools/basemap_pipeline/build_package.sh
```

Compatibility wrappers (same behavior):

- `tools/extract_oklahoma_counties.py` → `extract_region.py`
- `tools/prepare_demo_tiles.sh` → `build_package.sh`

Package contract: [docs/formats/data-packages.md](../../docs/formats/data-packages.md)  
Oklahoma guide: [docs/guides/oklahoma-tiles.md](../../docs/guides/oklahoma-tiles.md)
