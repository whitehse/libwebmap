#!/usr/bin/env python3
"""Extract GeoFabrik Shortbread MVT tiles for selected Oklahoma counties.

Source: https://download.geofabrik.de/north-america/us/oklahoma-shortbread-1.0.mbtiles
"""
from __future__ import annotations

import argparse
import math
import sqlite3
import zlib
from pathlib import Path

COUNTIES = [
    "Tulsa",
    "Wagoner",
    "Okmulgee",
    "Creek",
    "Okfuskee",
    "McIntosh",
    "Muskogee",
    "Seminole",
    "Lincoln",
]

# Approximate combined bbox (W, S, E, N) covering the listed counties.
DEFAULT_BBOX = (-97.15, 34.95, -95.05, 36.35)


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_range(z: int, west: float, south: float, east: float, north: float):
    xs, ys = [], []
    for lat in (south, north):
        for lon in (west, east):
            x, y = lonlat_to_tile(lon, lat, z)
            xs.append(x)
            ys.append(y)
    return min(xs), max(xs), min(ys), max(ys)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--mbtiles",
        default="data/oklahoma-shortbread-1.0.mbtiles",
        help="Path to GeoFabrik Shortbread mbtiles",
    )
    ap.add_argument("--out", default="data/oklahoma_counties_pbf")
    ap.add_argument("--zmin", type=int, default=8)
    ap.add_argument("--zmax", type=int, default=12)
    ap.add_argument(
        "--bbox",
        default=",".join(str(x) for x in DEFAULT_BBOX),
        help="W,S,E,N",
    )
    args = ap.parse_args()
    west, south, east, north = (float(x) for x in args.bbox.split(","))
    mb = Path(args.mbtiles)
    out = Path(args.out)
    if not mb.exists():
        raise SystemExit(f"missing {mb}; download oklahoma-shortbread-1.0.mbtiles")

    con = sqlite3.connect(str(mb))
    n_ok = n_miss = 0
    nbytes = 0
    for z in range(args.zmin, args.zmax + 1):
        x0, x1, y0, y1 = tile_range(z, west, south, east, north)
        print(f"z{z}: x {x0}-{x1} y {y0}-{y1}")
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                tms = (1 << z) - 1 - y
                row = con.execute(
                    "SELECT tile_data FROM tiles WHERE zoom_level=? AND tile_column=? AND tile_row=?",
                    (z, x, tms),
                ).fetchone()
                if not row:
                    n_miss += 1
                    continue
                data = row[0]
                if data[:2] == b"\x1f\x8b":
                    data = zlib.decompress(data, 16 + zlib.MAX_WBITS)
                dest = out / str(z) / str(x)
                dest.mkdir(parents=True, exist_ok=True)
                (dest / f"{y}.pbf").write_bytes(data)
                n_ok += 1
                nbytes += len(data)
    con.close()

    (out / "REGION.txt").write_text(
        "Oklahoma county subset for libwebmap\n"
        f"Source: {mb.name}\n"
        f"Counties: {', '.join(COUNTIES)}\n"
        f"BBox W/S/E/N: {west} {south} {east} {north}\n"
        f"Zooms: {args.zmin}-{args.zmax}\n"
        "License: ODbL 1.0 (OpenStreetMap contributors, Geofabrik)\n"
    )
    # Tulsa fixture
    tx, ty = lonlat_to_tile(-95.99, 36.15, 10)
    src = out / "10" / str(tx) / f"{ty}.pbf"
    fix = Path("fixtures/tulsa_z10")
    if src.exists():
        fix.mkdir(parents=True, exist_ok=True)
        (fix / f"{tx}_{ty}.pbf").write_bytes(src.read_bytes())
        print("fixture", fix)
    print(f"extracted {n_ok} tiles miss={n_miss} bytes={nbytes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
