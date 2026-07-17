# fiber2features

Tier B host tool (ADR-017): **CrescentLink-normalized fiber design SQLite** →
fiber map package (`.fmap` tiles + `features.sqlite` + manifest).

- Input contract: [docs/formats/fiber-design-input.md](../../docs/formats/fiber-design-input.md)
- Tile bytes: [docs/formats/fmap.md](../../docs/formats/fmap.md)
- Map tables: [tools/schema/schema_map.sql](../schema/schema_map.sql) (embedded at build)

## Build

```bash
cmake -B build -S .
cmake --build build --target fiber2features
# → build/fiber2features
```

Uses vendored SQLite amalgamation under `tools/third_party/sqlite/` (not linked
into WASM).

## Usage

Prefer the package recipe (manifest polish + optional diagrams + splice_detail):

```bash
export FIBER_DESIGN_DB=/path/to/fiber_design.sqlite
# export FIBER_DIAGRAMS_DIR=/path/to/html   # optional
./tools/build_fiber_package.sh
```

Low-level:

```bash
./build/fiber2features "$FIBER_DESIGN_DB" -o demo/fiber_data \
  --zmin 10 --zmax 14 --tap-zmin 13 --splice-zmin 13
```

Options: `--bbox W,S,E,N`, `--limit N`, `--extent`, `-q`.  
Manifest `diagrams_url` defaults to `null`; `build_fiber_package.sh` sets
`./splice_diagrams/` when diagrams are installed.

## Regenerate embedded schema

After editing `tools/schema/schema_map.sql`:

```bash
python3 tools/fiber2features/embed_schema.py
```

## Residual assumptions (v1)

Reads ECOEC / CrescentLink-normalized design DBs with **EPSG:2267** GPKG geom
(see fiber-design-input). Not multi-vendor-ready until Tier A emits WGS84 WKB.
