#!/usr/bin/env bash
# Convert county-limited Oklahoma Shortbread MVT → .wmap for the WebGPU demo.
# Limits zooms for browser/GPU memory (default z8–10; optional z11–12).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${ROOT}/build"
PBF="${ROOT}/data/oklahoma_counties_pbf"
OUT="${ROOT}/demo/tiles"
ZMIN="${ZMIN:-8}"
# z12 enables street-level detail; demo overzooms past this with vector scaling.
ZMAX="${ZMAX:-12}"

if [[ ! -x "${BUILD}/gfvtile2wmap" ]]; then
  echo "Building gfvtile2wmap..."
  cmake -B "${BUILD}" -S "${ROOT}"
  cmake --build "${BUILD}" --target gfvtile2wmap
fi

if [[ ! -d "${PBF}" ]]; then
  echo "Missing ${PBF}; extract from oklahoma-shortbread-1.0.mbtiles first."
  exit 1
fi

rm -rf "${OUT}"
mkdir -p "${OUT}"

echo "Converting z${ZMIN}-${ZMAX} → ${OUT}"
"${BUILD}/gfvtile2wmap" --dir "${PBF}" -o "${OUT}" \
  --zmin "${ZMIN}" --zmax "${ZMAX}" --quiet

# Manifest for demo loader (list tiles + center on Tulsa)
python3 - <<PY
import json, os
from pathlib import Path
root = Path("${OUT}")
tiles = []
for p in sorted(root.rglob("*.wmap")):
    # path: z/x/y.wmap
    parts = p.relative_to(root).parts
    if len(parts) != 3:
        continue
    z, x, y = int(parts[0]), int(parts[1]), int(parts[2].replace(".wmap",""))
    tiles.append({"z": z, "x": x, "y": y})
# Prefer z10 around Tulsa for initial view
manifest = {
    "source": "GeoFabrik oklahoma-shortbread-1.0.mbtiles",
    "counties": ["Tulsa","Wagoner","Okmulgee","Creek","Okfuskee","McIntosh","Muskogee","Seminole","Lincoln"],
    "bbox": [-97.15, 34.95, -95.05, 36.35],
    "center": [-95.99, 36.15],
    "zoom": 10,
    "zmin": ${ZMIN},
    "zmax": ${ZMAX},
    "tiles": tiles,
}
(root / "manifest.json").write_text(json.dumps(manifest, indent=2))
total = sum(p.stat().st_size for p in root.rglob("*.wmap"))
print(f"manifest: {len(tiles)} tiles, {total/1e6:.1f} MB .wmap")
PY

echo "Done. Serve with: python3 -m http.server -d ${ROOT}/demo 8765"
