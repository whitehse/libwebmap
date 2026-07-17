# ADR-017: Three-tier data boundary (sources / packages / display)

## Status

Accepted

## Date

2026-07-17

## Context

libwebmap is a pure-C WebGPU map engine (ADR-004, ADR-007, ADR-014), but demo
docs and data recipes still treat `~/crescentlink_export` as an implicit second
half of the product. Fiber bake tools, optical path walking, and vendor
GeoPackage extraction live outside this tree, while display formats (`.wmap`,
`.fmap`, splice-detail JSON) and the WebGPU host live inside it.

Without a named boundary:

- Ownership of `.fmap` and map packages is ambiguous (format comments point at
  crescentlink C headers; ADR-015 already split data vs paint inside the map).
- Operators must know both trees and absolute home-directory paths to regenerate
  demo data.
- Future adapters (other fiber vendors, weather/wind) risk being wired the same
  ad-hoc way into the map engine.

ADR-014 (plumbing vs host) and ADR-015 (fiber data vs display) remain in force;
this ADR places **upstream producers** and **on-disk packages** relative to that
split. Full design and PR plan: [docs/designs/data-sources-display-separation.md](../designs/data-sources-display-separation.md).

## Decision

### Three tiers

| Tier | Responsibility | I/O | Examples (today / target) |
|------|----------------|-----|---------------------------|
| **A — Source adapter** | Parse vendor dumps; normalize connectivity and raw geospatial | Files, GDAL, libxml2, optional network | CrescentLink `export_fiber_design`, `trace_fiber_paths.py`, `splice_diagram`; GeoFabrik MBTiles extract; future weather adapters |
| **B — Map package bake** | Produce **display packages** from a documented intermediate schema | Host tools only (files) | `gfvtile2wmap`, `export_splice_detail.py`, basemap pipeline; target: `fiber2features`, `export_path_index` under libwebmap `tools/` |
| **C — Display** | Hold map data, GPU descriptors, paint, interaction | Core: **no syscalls**; host: fetch + WebGPU | `libwebmap` C/WASM, `demo/display/` |

```
Tier A                    Tier B                         Tier C
────────                  ──────                         ──────
CrescentLink GPKG ──► fiber_design.sqlite ──► fiber package ──► host display
GeoFabrik Shortbread ──► MVT/PBF tree ──► basemap package ──► libwebmap core
Weather (future) ──► raw feed ──► weather package ──► host overlays
```

### Hard rules

1. **Tier C never imports** CrescentLink types, GPKG layer names, or
   `xmlEquipment` shapes. Runtime consumes packages and host-fed overlays only.
2. **Tier B does not open vendor dumps** (no GPKG). It reads intermediate
   SQLite (fiber design), MVT/PBF trees (basemap), or other documented package
   inputs.
3. **libwebmap owns display formats** (`.wmap`, `.fmap`, splice_detail,
   path_index, package manifests). Specs live with consumers (this repo).
4. **crescentlink_export (or successor) is a Tier A adapter** — GPKG/XML export,
   optical path graph walk, optional HTML splice diagrams — not the map engine.
5. **No third `map_data` repository for v1.** Map-facing bake tools live under
   libwebmap `tools/` once moved; crescentlink may hard-wrap them after the move
   (implementation PRs follow this ADR).
6. **Weather / wind** are future overlay **packages** (and host paint), not C-core
   tile layers or in-library network ingest.
7. **Demo decoupling target:** regenerate fiber packages from an env-pointed
   design DB (`FIBER_DESIGN_DB`); bake tools must not write absolute source paths
   by default. HTML splice diagrams are **optional** package inputs
   (`FIBER_DIAGRAMS_DIR` / `diagrams_url`); paint and path-trace demos must work
   without a second git tree checked out.
8. **CRS honesty:** Until Tier A emits WGS84 WKB, Tier B may still understand
   CrescentLink-normalized ECOEC geometry (GeoPackage binary, EPSG:2267). That
   residual coupling is **documented**, not claimed multi-vendor-ready. Long-term
   design-DB geometry is WGS84 WKB so Tier B can drop inverse projection.

### Placement (vocabulary; code moves are later PRs)

| Artifact | Tier | Home (target) |
|----------|------|----------------|
| `export_fiber_design*`, `trace_fiber_paths.py`, `splice_diagram` | A | crescentlink_export |
| GeoFabrik / Shortbread extract → PBF | A (+ bake entry) | libwebmap basemap pipeline (promote scripts) |
| `gfvtile2wmap`, MVT decoder | B | libwebmap (already) |
| `export_splice_detail.py` | B | libwebmap (already) |
| `fiber2features` → `.fmap` + `features.sqlite` | B | **move** to libwebmap `tools/` |
| Path-index export | B | **new** libwebmap `tools/` |
| `fiber2wmap` | B legacy | crescentlink until retired |
| C/WASM core + `demo/display/` | C | libwebmap |

### Path tracing (direction only)

Optical path walks stay in Tier A (`fiber_paths` / `fiber_path_hops`). Map-facing
highlight uses a precomputed **path_index** package artifact and host display —
no graph walk in WASM/core for v1. Format and UI details are follow-on ADRs/PRs
(see design doc).

## Consequences

- Docs and architecture diagrams name **source**, **package**, and **display**
  instead of “run something in crescentlink then symlink into demo.”
- Moving `fiber2features` and path-index export into this repo becomes a
  format-ownership change, not a product merger with CrescentLink.
- Operators can treat crescentlink as an optional adapter that produces a design
  DB; libwebmap tools turn that into packages the demo loads.
- Residual ECOEC CRS assumptions must stay explicit until Tier A normalizes geom.
- Sibling telemetry (netforensics, CPE, inventory) continues to feed **overlays**
  into Tier C the same way; they are status sources, not basemap/fiber package
  bakers unless they later produce package layouts.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Docs-only coupling (no tier names) | Leaves ownership and CRS claims ambiguous |
| New standalone `map_data` repo for v1 | Extra coordination for two trees and one operator machine |
| Absorb CrescentLink GPKG/XML into libwebmap | Violates syscall-free core and vendor-adapter boundary |
| Browser/WASM graph walk for fiber paths | Wrong tier; path walk already exists offline in design DB |
| Weather as first-class C tile cache | Overbuilds core; ADR-014 host boundary |

## References

- Design: [docs/designs/data-sources-display-separation.md](../designs/data-sources-display-separation.md)
- Formats: [data-packages.md](../formats/data-packages.md), [fmap.md](../formats/fmap.md),
  [fiber-design-input.md](../formats/fiber-design-input.md),
  [path-index.md](../formats/path-index.md),
  [weather-package.md](../formats/weather-package.md)
- ADR-011 GeoFabrik MVT · ADR-014 host boundary · ADR-015 data/display · ADR-016 magnifier · ADR-018 path trace
- `docs/guides/fiber-map-data.md` — fiber package recipe (`FIBER_DESIGN_DB`)
