#!/usr/bin/env python3
"""Compatibility wrapper — prefer tools/basemap_pipeline/extract_region.py."""
from __future__ import annotations

import runpy
import sys
from pathlib import Path

_script = Path(__file__).resolve().parent / "basemap_pipeline" / "extract_region.py"
if not _script.is_file():
    raise SystemExit(f"missing {_script}")
sys.argv[0] = str(_script)
runpy.run_path(str(_script), run_name="__main__")
