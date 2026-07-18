#!/usr/bin/env bash
# Build a fiber map package from a normalized design SQLite (Tier B, ADR-017).
#
# Required:
#   FIBER_DESIGN_DB   path to fiber_design.sqlite (Tier A intermediate)
#
# Optional:
#   OUT               package root (default: demo/fiber_data)
#   DIAGRAMS_OUT      HTML splice diagram directory (default: <demo>/splice_diagrams)
#                     Generated as a real directory (not a symlink).
#   SKIP_DIAGRAMS=1   skip HTML diagram generation
#   DIAGRAMS_LIMIT    max diagrams (0 = all; passed to splice_diagram --limit)
#   ZMIN ZMAX TAP_ZMIN SPLICE_ZMIN LIMIT  zoom / sample controls
#   SKIP_SPLICE_DETAIL=1   skip magnifier JSON export
#   SKIP_PATH_INDEX=1      skip optical path_index (needs fiber_paths tables)
#   PATH_INDEX_LIMIT       max paths to export (0 = all)
#   BUILD             cmake build dir (default: <repo>/build)
#
# Does not require a fixed sibling checkout path. Diagrams are optional —
# paint + magnifier work without them; click-through HTML needs generation
# (or a pre-populated DIAGRAMS_OUT directory).
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
SKIP_DIAGRAMS="${SKIP_DIAGRAMS:-0}"
PATH_INDEX_LIMIT="${PATH_INDEX_LIMIT:-0}"
DIAGRAMS_LIMIT="${DIAGRAMS_LIMIT:-0}"

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

ensure_tool() {
  local name="$1"
  local bin="${BUILD}/${name}"
  if [[ ! -x "${bin}" ]]; then
    echo "Building ${name}..."
    cmake -B "${BUILD}" -S "${ROOT}"
    cmake --build "${BUILD}" --target "${name}"
  fi
  if [[ ! -x "${bin}" ]]; then
    echo "error: missing ${bin}" >&2
    exit 1
  fi
  echo "${bin}"
}

F2F="$(ensure_tool fiber2features)"

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

# HTML diagrams: generate a real directory under the demo host root.
DEMO_ROOT="$(cd "$(dirname "${OUT}")" && pwd)"
DIAGRAMS_OUT="${DIAGRAMS_OUT:-${DEMO_ROOT}/splice_diagrams}"
HAS_DIAGRAMS=0

if [[ "${SKIP_DIAGRAMS}" == "1" ]]; then
  if [[ -d "${DIAGRAMS_OUT}" ]] && [[ ! -L "${DIAGRAMS_OUT}" ]] && \
     compgen -G "${DIAGRAMS_OUT}/*.html" > /dev/null; then
    HAS_DIAGRAMS=1
    echo "diagrams: skipped generation; using existing ${DIAGRAMS_OUT}"
  else
    echo "diagrams: skipped (SKIP_DIAGRAMS=1); click-through disabled"
  fi
else
  SD="$(ensure_tool splice_diagram)"
  # Replace symlink with a real directory before writing.
  if [[ -L "${DIAGRAMS_OUT}" ]]; then
    echo "diagrams: removing symlink ${DIAGRAMS_OUT}"
    rm -f "${DIAGRAMS_OUT}"
  fi
  mkdir -p "${DIAGRAMS_OUT}"
  SD_ARGS=(--all -o "${DIAGRAMS_OUT}" "${FIBER_DESIGN_DB}")
  if [[ "${DIAGRAMS_LIMIT}" != "0" ]]; then
    SD_ARGS+=(--limit "${DIAGRAMS_LIMIT}")
  fi
  echo "splice_diagram → ${DIAGRAMS_OUT}"
  if "${SD}" "${SD_ARGS[@]}"; then
    HAS_DIAGRAMS=1
  else
    echo "warn: splice_diagram failed; click-through disabled" >&2
  fi
fi

# Patch package manifest: relative URLs only, optional diagrams_url
export OUT HAS_DIAGRAMS
# diagrams_url is page-relative to DEMO_ROOT when diagrams live next to fiber_data
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
