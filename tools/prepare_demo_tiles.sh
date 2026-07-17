#!/usr/bin/env bash
# Compatibility wrapper — prefer tools/basemap_pipeline/build_package.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
exec "${ROOT}/basemap_pipeline/build_package.sh" "$@"
