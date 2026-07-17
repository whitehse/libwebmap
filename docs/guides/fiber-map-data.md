# Fiber map data and display

Fiber design is split into **data** (table-like features) and **display**
(style + tessellation + screen symbols). This matches ADR-014: the host owns
how geometry is drawn.

**Format ownership (ADR-017 / PR2):** normative specs live under
[`docs/formats/`](../formats/) — [data-packages.md](../formats/data-packages.md)
(manifests), [fmap.md](../formats/fmap.md) (`.fmap` bytes),
[fiber-design-input.md](../formats/fiber-design-input.md) (intermediate design
DB + CRS). Full operator recipe rewrite (env vars, optional diagrams, no
absolute sibling paths) is deferred to a later cleanup PR; this guide remains
the practical regenerate steps for now.

## Pipeline

```
fiber_design.sqlite          # export_fiber_design (connectivity)
        │
        ├─► fiber2features
        │     features.sqlite              # map_cables + map_taps + map_splices
        │     diagram_index.json           # splicepoint guid → diagram HTML basename
        │     fiber_data/{z}/{x}/{y}.fmap  # tiled feature rows (no pixel radii / n-gons)
        │     manifest.json
        │
        └─► tools/export_splice_detail.py
              fiber_data/splice_detail/<guid>.json   # compact local connectivity
        │
        ▼  demo/display/
fiber_style.js               # widths, radii, min-zooms, diagram URLs, magnifier
fiber_fmap.js                # parse .fmap v2
fiber_schematic.js           # Canvas2D tap / multi-cable / line callouts
fiber_magnifier.js           # hover dwell + lens + detail fetch
fiber_layer.js               # WebGPU lines + Canvas symbols + hover + click
```

Splice HTML diagrams live under `demo/splice_diagrams/` (symlink or copy from
`crescentlink_export/splice_diagrams`). Click a tap or splice symbol to open
`./splice_diagrams/<basename>` in a new tab.

**Hover magnifier (≈500 ms dwell):** enlarges the feature under the pointer and
shows a compact local schematic (when detail JSON is present):

| Feature | Magnifier content |
|---------|-------------------|
| **Tap** | Tap value (e.g. `2P-14`), station id, primary light loss (dB), feed **IN** / **PT** fibers with PT loss, **drops to home** (open vs patched) with per-port loss, and **through** cable↔cable fuse splices as fiber pairs |
| **Splice** (no tap) | Enclosure diagram: two-cable fiber-by-fiber fuse view, multi-cable fan with pair counts, or single-cable + equipment ports; loss labels when non-zero |
| **Cable / drop** | Size callout (drops dashed / warmer) |

Fmap-only fallback (no detail file) still enlarges the map symbol. Click opens the
full HTML splice diagram. See ADR-016.

## Tables (`features.sqlite`)

| Table | Rows |
|-------|------|
| `map_cables` | One span per cable/drop; `is_drop`, `cable_size`, colors, optional WKB |
| `map_taps` | `lon`, `lat`, **`ports`**, `sp_guid`, `diagram`, strand/tube colors |
| `map_splices` | Non-tap splicepoints; `sp_guid`, `station_id`, `diagram` |

Query example:

```sql
SELECT ports, lon, lat, sp_guid, diagram FROM map_taps LIMIT 10;
SELECT sp_guid, station_id, diagram FROM map_splices LIMIT 10;
```

## `.fmap` tiles (v2)

Binary feature packs for the browser. **Normative layout:**
[docs/formats/fmap.md](../formats/fmap.md). Contents are **rows**:

- cables / drops: polyline points in tile-local coords + size + packed RGBA
  (no cable GUID until planned fmap v3)
- taps: point + `ports` + strand/tube RGBA + 16-byte splicepoint GUID
- splices: point + RGBA + 16-byte GUID (only SPs **without** a tap)

No triangle fans, no screen-space radii.

## Display (`demo/display/`)

| Module | Role |
|--------|------|
| `fiber_style.js` | Display policy (px widths, radii vs zoom, diagram URL, magnifier) |
| `fiber_fmap.js` | Decode `.fmap` → JS objects |
| `fiber_schematic.js` | Magnifier schematic drawing (tap / fuse / line) |
| `fiber_magnifier.js` | Hover delay, detail cache, glass lens |
| `fiber_layer.js` | Extrude lines for WebGPU; paint symbols; pick + hover + click |

| Symbol | Meaning |
|--------|---------|
| **Circle + digit** | Tap (drop port count); strand fill, tube stroke |
| **Hexagon** | Splicepoint with no tap (enclosure) |
| **Solid line** | Mainline cable |
| **(style)** | Drop cable (narrower; dashed in magnifier) |

Symbols grow with zoom. Hover ≥0.5 s opens the magnifier; click opens the full
splice diagram when a matching file exists under `splice_diagrams/`.

## Compact splice detail (`splice_detail/`)

One JSON object per splicepoint GUID (schema `v: 1`):

| Field | Content |
|-------|---------|
| `kind` | `tap` or `splice` |
| `station_id` | Optional field id |
| `tap` | **name** (e.g. `2P-14`), ports, **loss_db**, tube/strand colors |
| `cables[]` | guid, size, `is_drop` |
| `links[]` | `ingress` / `egress` / `drop` / `fuse` / `equip` (+ fiber endpoints, **loss_db**) |

Lazy-fetched as `{fiber_data base}/splice_detail/<guid>.json` when the magnifier
opens (demo default: `./fiber_data/splice_detail/<guid>.json`). Manifest field
`splice_detail_url` is joined with the fiber_data baseUrl when it is relative
(e.g. `./splice_detail/`); do not rely on a page-root `./splice_detail/` path —
that 404s and the lens falls back to an enlarged symbol only.

The directory is **gitignored** (large / regenerable); fmap-only magnifier content
still works without it.

## Regenerate demo data

Design DB is still produced by **crescentlink_export** (Tier A). Package bake
is **libwebmap** `fiber2features` (Tier B):

```bash
# Tier A (once): export + optional path walk
#   cd ~/crescentlink_export && ./export_fiber_design … fiber_design.sqlite

cmake --build ~/libwebmap/build --target fiber2features
./build/fiber2features ~/crescentlink_export/fiber_design_test.sqlite \
  -o demo/fiber_data --zmin 10 --zmax 14 --tap-zmin 13 --splice-zmin 13

# Compact connectivity for hover magnifier (map SPs only)
python3 tools/export_splice_detail.py \
  ~/crescentlink_export/fiber_design_test.sqlite \
  -o demo/fiber_data/splice_detail \
  --map-db demo/fiber_data/features.sqlite \
  --manifest demo/fiber_data/manifest.json

# Diagrams for click-through (optional; symlink is fine)
ln -sfn ~/crescentlink_export/splice_diagrams demo/splice_diagrams

python3 -m http.server -d demo 8765
```

Basemap remains `demo/basemap/` (`tools/basemap_pipeline/build_package.sh`).
Do not name basemap paths `tiles/` if your reverse proxy intercepts that segment.

A crescentlink `./fiber2features` **wrapper** exists only to exec
`libwebmap/build/fiber2features` (fails loudly if missing).

## Legacy

`fiber2wmap` still builds pre-tessellated `.wmap` fiber tiles for tools that
need GPU-ready geometry offline. The WebGPU demo prefers **`.fmap` + display
module** so data and paint stay separate.
