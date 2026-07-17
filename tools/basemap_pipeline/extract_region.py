#!/usr/bin/env python3
"""Extract GeoFabrik Shortbread (or other MBTiles MVT) tiles for a region bbox.

Tier A/B basemap adapter helper (ADR-017). Default region is the nine-county
Oklahoma ECOEC experiment. Output is a {z}/{x}/{y}.pbf tree for gfvtile2wmap.

Source (Oklahoma default):
  https://download.geofabrik.de/north-america/us/oklahoma-shortbread-1.0.mbtiles
"""
from __future__ import annotations

import argparse
import math
import sqlite3
import zlib
from pathlib import Path

# Default: nine-county Oklahoma experiment (see docs/guides/oklahoma-tiles.md)
DEFAULT_COUNTIES = [
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
DEFAULT_BBOX = (-97.15, 34.95, -95.05, 36.35)
DEFAULT_CENTER = (-95.99, 36.15)  # Tulsa area fixture seed


def lonlat_to_tile(lon: float, lat: float, z: int) -> tuple[int, int]:
    n = 2**z
    x = int((lon + 180.0) / 360.0 * n)
    lat_rad = math.radians(lat)
    y = int((1.0 - math.asinh(math.tan(lat_rad)) / math.pi) / 2.0 * n)
    return max(0, min(n - 1, x)), max(0, min(n - 1, y))


def tile_range(
    z: int, west: float, south: float, east: float, north: float
) -> tuple[int, int, int, int]:
    xs, ys = [], []
    for lat in (south, north):
        for lon in (west, east):
            x, y = lonlat_to_tile(lon, lat, z)
            xs.append(x)
            ys.append(y)
    return min(xs), max(xs), min(ys), max(ys)


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Extract MVT .pbf tiles from an MBTiles Shortbread package"
    )
    ap.add_argument(
        "--mbtiles",
        default="data/oklahoma-shortbread-1.0.mbtiles",
        help="Path to GeoFabrik Shortbread (or other) mbtiles",
    )
    ap.add_argument(
        "--out",
        default="data/oklahoma_counties_pbf",
        help="Output {z}/{x}/{y}.pbf tree",
    )
    ap.add_argument("--zmin", type=int, default=8)
    ap.add_argument("--zmax", type=int, default=12)
    ap.add_argument(
        "--bbox",
        default=",".join(str(x) for x in DEFAULT_BBOX),
        help="W,S,E,N degrees",
    )
    ap.add_argument(
        "--name",
        default="oklahoma_counties",
        help="Region name written into REGION.txt",
    )
    ap.add_argument(
        "--counties",
        default=",".join(DEFAULT_COUNTIES),
        help="Comma-separated county labels for REGION.txt (optional)",
    )
    ap.add_argument(
        "--fixture",
        default="fixtures/tulsa_z10",
        help="If set, copy z10 tile at --fixture-lon/lat into this dir "
        "(empty string to skip)",
    )
    ap.add_argument(
        "--fixture-lon",
        type=float,
        default=DEFAULT_CENTER[0],
        help="Lon for optional CI fixture tile",
    )
    ap.add_argument(
        "--fixture-lat",
        type=float,
        default=DEFAULT_CENTER[1],
        help="Lat for optional CI fixture tile",
    )
    args = ap.parse_args()

    west, south, east, north = (float(x) for x in args.bbox.split(","))
    counties = [c.strip() for c in args.counties.split(",") if c.strip()]
    mb = Path(args.mbtiles)
    out = Path(args.out)
    if not mb.exists():
        raise SystemExit(
            f"missing {mb}; download oklahoma-shortbread-1.0.mbtiles "
            "(see docs/guides/oklahoma-tiles.md)"
        )

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
                    "SELECT tile_data FROM tiles WHERE zoom_level=? "
                    "AND tile_column=? AND tile_row=?",
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

    region_lines = [
        f"{args.name} — MVT extract for libwebmap basemap pipeline\n",
        f"Source: {mb.name}\n",
        f"Adapter: geofabrik_shortbread\n",
        f"BBox W/S/E/N: {west} {south} {east} {north}\n",
        f"Zooms: {args.zmin}-{args.zmax}\n",
        "License: ODbL 1.0 (OpenStreetMap contributors, Geofabrik)\n",
    ]
    if counties:
        region_lines.insert(3, f"Counties: {', '.join(counties)}\n")
    (out / "REGION.txt").write_text("".join(region_lines))

    if args.fixture:
        fix = Path(args.fixture)
        tx, ty = lonlat_to_tile(args.fixture_lon, args.fixture_lat, 10)
        src = out / "10" / str(tx) / f"{ty}.pbf"
        if src.exists():
            fix.mkdir(parents=True, exist_ok=True)
            (fix / f"{tx}_{ty}.pbf").write_bytes(src.read_bytes())
            print("fixture", fix / f"{tx}_{ty}.pbf")
        else:
            print(f"fixture skip: missing {src}")

    print(f"extracted {n_ok} tiles miss={n_miss} bytes={nbytes}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
