#!/usr/bin/env bash
# Build a fiber map package from a normalized design SQLite (Tier B, ADR-017).
#
# Required:
#   FIBER_DESIGN_DB   path to fiber_design.sqlite (Tier A intermediate)
#
# Optional:
#   OUT               package root (default: demo/fiber_data)
#   FIBER_DIAGRAMS_DIR  HTML splice diagrams directory to symlink as
#                     demo/splice_diagrams (or next to package root's parent demo/)
#   ZMIN ZMAX TAP_ZMIN SPLICE_ZMIN LIMIT  zoom / sample controls
#   SKIP_SPLICE_DETAIL=1   skip magnifier JSON export
#   SKIP_PATH_INDEX=1      skip optical path_index (needs fiber_paths tables)
#   PATH_INDEX_LIMIT       max paths to export (0 = all)
#   BUILD             cmake build dir (default: <repo>/build)
#
# Does not require a fixed sibling checkout path. Diagrams are optional —
# paint + magnifier work without them; click-through HTML needs FIBER_DIAGRAMS_DIR.
# Path index is optional for paint; required for path-trace UI (PR8).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD="${BUILD:-${ROOT}/build}"
OUT="${OUT:-${ROOT}/demo/fiber_data}"
ZMIN="${ZMIN:-10}"
ZMAX="${ZMAX:-14}"
TAP_ZMIN="${TAP_ZMIN:-13}"
SPLICE_ZMIN="${SPLICE_ZMIN:-13}"
LIMIT="${LIMIT:-0}"
SKIP_SPLICE_DETAIL="${SKIP_SPLICE_DETAIL:-0}"
SKIP_PATH_INDEX="${SKIP_PATH_INDEX:-0}"
PATH_INDEX_LIMIT="${PATH_INDEX_LIMIT:-0}"

if [[ -z "${FIBER_DESIGN_DB:-}" ]]; then
  echo "error: set FIBER_DESIGN_DB to a fiber design SQLite path" >&2
  echo "  example: FIBER_DESIGN_DB=/path/to/fiber_design.sqlite $0" >&2
  echo "  Tier A: export_fiber_design (crescentlink_export or other adapter)" >&2
  exit 1
fi

if [[ ! -f "${FIBER_DESIGN_DB}" ]]; then
  echo "error: FIBER_DESIGN_DB not found: ${FIBER_DESIGN_DB}" >&2
  exit 1
fi

F2F="${BUILD}/fiber2features"
if [[ ! -x "${F2F}" ]]; then
  echo "Building fiber2features..."
  cmake -B "${BUILD}" -S "${ROOT}"
  cmake --build "${BUILD}" --target fiber2features
fi

echo "fiber package: ${FIBER_DESIGN_DB} → ${OUT}"
mkdir -p "${OUT}"

F2F_ARGS=(
  "${FIBER_DESIGN_DB}"
  -o "${OUT}"
  --zmin "${ZMIN}"
  --zmax "${ZMAX}"
  --tap-zmin "${TAP_ZMIN}"
  --splice-zmin "${SPLICE_ZMIN}"
)
if [[ "${LIMIT}" != "0" ]]; then
  F2F_ARGS+=(--limit "${LIMIT}")
fi

"${F2F}" "${F2F_ARGS[@]}"

if [[ "${SKIP_SPLICE_DETAIL}" != "1" ]]; then
  if [[ -f "${ROOT}/tools/export_splice_detail.py" ]]; then
    echo "export_splice_detail → ${OUT}/splice_detail"
    python3 "${ROOT}/tools/export_splice_detail.py" \
      "${FIBER_DESIGN_DB}" \
      -o "${OUT}/splice_detail" \
      --map-db "${OUT}/features.sqlite" \
      --manifest "${OUT}/manifest.json"
  else
    echo "warn: tools/export_splice_detail.py missing; skipping splice_detail" >&2
  fi
fi

if [[ "${SKIP_PATH_INDEX}" != "1" ]]; then
  if [[ -f "${ROOT}/tools/export_path_index.py" ]]; then
    echo "export_path_index → ${OUT}/path_index"
    PI_ARGS=("${FIBER_DESIGN_DB}" -o "${OUT}")
    if [[ "${PATH_INDEX_LIMIT}" != "0" ]]; then
      PI_ARGS+=(--limit "${PATH_INDEX_LIMIT}")
    fi
    # Soft-fail: package paint works without paths; trace UI needs them
    if ! python3 "${ROOT}/tools/export_path_index.py" "${PI_ARGS[@]}"; then
      echo "warn: path_index skipped (no fiber_paths or export failed)" >&2
    fi
  else
    echo "warn: tools/export_path_index.py missing; skipping path_index" >&2
  fi
fi

# Optional HTML diagrams (page-relative URL for the demo host)
DEMO_ROOT="$(cd "$(dirname "${OUT}")" && pwd)"
DIAGRAMS_LINK="${DEMO_ROOT}/splice_diagrams"
HAS_DIAGRAMS=0
if [[ -n "${FIBER_DIAGRAMS_DIR:-}" ]]; then
  if [[ ! -d "${FIBER_DIAGRAMS_DIR}" ]]; then
    echo "error: FIBER_DIAGRAMS_DIR is not a directory: ${FIBER_DIAGRAMS_DIR}" >&2
    exit 1
  fi
  ln -sfn "$(cd "${FIBER_DIAGRAMS_DIR}" && pwd)" "${DIAGRAMS_LINK}"
  HAS_DIAGRAMS=1
  echo "diagrams: ${DIAGRAMS_LINK} → ${FIBER_DIAGRAMS_DIR}"
elif [[ -d "${DIAGRAMS_LINK}" ]] || [[ -L "${DIAGRAMS_LINK}" ]]; then
  HAS_DIAGRAMS=1
  echo "diagrams: using existing ${DIAGRAMS_LINK}"
else
  echo "diagrams: none (paint + magnifier still work; click-through disabled)"
fi

# Patch package manifest: relative URLs only, optional diagrams_url
export OUT HAS_DIAGRAMS
python3 - <<'PY'
import json
import os
from pathlib import Path

out = Path(os.environ["OUT"])
man_path = out / "manifest.json"
man = json.loads(man_path.read_text())
# Package fields (keep existing fmap_version / source from fiber2features)
man.setdefault("kind", "fiber")
man.setdefault("format_version", 1)
man["features_sqlite"] = "features.sqlite"
man["diagram_index"] = "diagram_index.json"
man["splice_detail_url"] = "./splice_detail/"
if os.environ.get("HAS_DIAGRAMS") == "1":
    # Page-relative for demo host (not under fiber_data/)
    man["diagrams_url"] = "./splice_diagrams/"
else:
    man["diagrams_url"] = None
# Never leave absolute input paths
src = man.get("source")
if isinstance(src, dict) and "input" in src:
    del src["input"]
if "input" in man:
    del man["input"]
man_path.write_text(json.dumps(man, indent=2) + "\n")
print(f"manifest: kind={man.get('kind')} fmap_version={man.get('fmap_version')} "
      f"diagrams_url={man.get('diagrams_url')!r}")
PY

echo "Done. Serve: python3 -m http.server -d ${DEMO_ROOT} 8765"
echo "  (basemap package: tools/basemap_pipeline/build_package.sh → demo/basemap/)"
