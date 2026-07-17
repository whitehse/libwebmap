#!/usr/bin/env bash
# Build a basemap package (.wmap + package manifest) from an MVT .pbf tree.
# Tier B bake (ADR-017). Default: Oklahoma county Shortbread → demo/basemap.
#
# Env overrides:
#   PBF     input {z}/{x}/{y}.pbf tree (default data/oklahoma_counties_pbf)
#   OUT     package root (default demo/basemap)
#   ZMIN / ZMAX  zoom range (default 8–12)
#   NAME    package name (default oklahoma_counties)
#   SOURCE_LABEL  human source string for manifest
#   ADAPTER package source.adapter (default geofabrik_shortbread)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
BUILD="${BUILD:-${ROOT}/build}"
PBF="${PBF:-${ROOT}/data/oklahoma_counties_pbf}"
OUT="${OUT:-${ROOT}/demo/basemap}"
ZMIN="${ZMIN:-8}"
# z12 enables street-level detail; demo overzooms past this with vector scaling.
ZMAX="${ZMAX:-12}"
NAME="${NAME:-oklahoma_counties}"
SOURCE_LABEL="${SOURCE_LABEL:-GeoFabrik oklahoma-shortbread-1.0.mbtiles}"
ADAPTER="${ADAPTER:-geofabrik_shortbread}"

# Default ECOEC demo region (match extract_region defaults)
BBOX_JSON="${BBOX_JSON:-[ -97.15, 34.95, -95.05, 36.35 ]}"
CENTER_JSON="${CENTER_JSON:-[ -95.99, 36.15 ]}"
ZOOM="${ZOOM:-10}"
COUNTIES_JSON="${COUNTIES_JSON:-[\"Tulsa\",\"Wagoner\",\"Okmulgee\",\"Creek\",\"Okfuskee\",\"McIntosh\",\"Muskogee\",\"Seminole\",\"Lincoln\"]}"

if [[ ! -x "${BUILD}/gfvtile2wmap" ]]; then
  echo "Building gfvtile2wmap..."
  cmake -B "${BUILD}" -S "${ROOT}"
  cmake --build "${BUILD}" --target gfvtile2wmap
fi

if [[ ! -d "${PBF}" ]]; then
  echo "Missing ${PBF}; extract MVT first:"
  echo "  python3 ${ROOT}/tools/basemap_pipeline/extract_region.py"
  exit 1
fi

rm -rf "${OUT}"
mkdir -p "${OUT}"

echo "Converting z${ZMIN}-${ZMAX} → ${OUT}"
"${BUILD}/gfvtile2wmap" --dir "${PBF}" -o "${OUT}" \
  --zmin "${ZMIN}" --zmax "${ZMAX}" --quiet

export OUT ZMIN ZMAX NAME SOURCE_LABEL ADAPTER ZOOM
export BBOX_JSON CENTER_JSON COUNTIES_JSON
python3 - <<'PY'
import json
import os
from datetime import datetime, timezone
from pathlib import Path

root = Path(os.environ["OUT"])
zmin = int(os.environ["ZMIN"])
zmax = int(os.environ["ZMAX"])
name = os.environ["NAME"]
label = os.environ["SOURCE_LABEL"]
adapter = os.environ["ADAPTER"]
zoom = float(os.environ["ZOOM"])
bbox = json.loads(os.environ["BBOX_JSON"])
center = json.loads(os.environ["CENTER_JSON"])
counties = json.loads(os.environ["COUNTIES_JSON"])

tiles = []
for p in sorted(root.rglob("*.wmap")):
    parts = p.relative_to(root).parts
    if len(parts) != 3:
        continue
    z = int(parts[0])
    x = int(parts[1])
    y = int(parts[2].replace(".wmap", ""))
    tiles.append({"z": z, "x": x, "y": y})

# Package contract: docs/formats/data-packages.md (format_version 1)
# source is structured; main.js also accepts legacy top-level string.
manifest = {
    "kind": "basemap",
    "format_version": 1,
    "name": name,
    "source": {
        "adapter": adapter,
        "label": label,
    },
    "counties": counties,
    "bbox": bbox,
    "center": center,
    "zoom": zoom,
    "zmin": zmin,
    "zmax": zmax,
    "crs_display": "EPSG:3857",
    "created_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "tiles": tiles,
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
total = sum(p.stat().st_size for p in root.rglob("*.wmap"))
print(
    f"manifest: {len(tiles)} tiles, {total/1e6:.1f} MB .wmap "
    f"(kind=basemap format_version=1)"
)
PY

echo "Done. Serve with: python3 -m http.server -d ${ROOT}/demo 8765"
