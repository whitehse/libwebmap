#!/usr/bin/env python3
"""
Export precomputed optical path index for the webmap host (Tier B, ADR-017).

Reads fiber_paths + fiber_path_hops from a design SQLite (Tier A intermediate
after trace_fiber_paths.py) and writes browser default files:

  OUT/path_index/meta.json
  OUT/path_index/cable_to_paths.json
  OUT/path_index/paths.jsonl

Optionally also OUT/path_index.sqlite for offline tools.

Geometry: fiber_paths.geom_wkb is plain ISO WKB in design CRS (ECOEC:
EPSG:2267 US survey feet). Output lonlat is always WGS84 (EPSG:4326).

Fail-closed if fiber_paths is missing or empty.

Usage:
  python3 tools/export_path_index.py \"$FIBER_DESIGN_DB\" -o demo/fiber_data
  python3 tools/export_path_index.py design.sqlite -o /tmp/pkg --limit 100
  python3 tools/export_path_index.py --self-test

See docs/formats/path-index.md
"""
from __future__ import annotations

import argparse
import json
import math
import os
import sqlite3
import struct
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence, Tuple

US_FT = 0.3048006096012192
PATH_INDEX_FORMAT = 1
MAX_HOPS_EXPORT = 256  # hard cap per path in package (UI also caps)
MAX_VERTS_EXPORT = 50_000


# ── EPSG:2267 (NAD83 Oklahoma North ftUS) → WGS84 ────────────────────


class OkNorth:
    """Lambert Conformal Conic 2SP inverse (matches fiber2features ok_north_*)."""

    def __init__(self) -> None:
        self.a = 6378137.0
        f = 1.0 / 298.257222101
        self.e2 = f * (2.0 - f)
        self.e = math.sqrt(self.e2)
        phi1 = math.radians(35.0 + 34.0 / 60.0)
        phi2 = math.radians(36.0 + 46.0 / 60.0)
        phi0 = math.radians(35.0)
        self.lam0 = math.radians(-98.0)
        self.FE = 1968500.0 * US_FT
        self.FN = 0.0

        def m(phi: float) -> float:
            s = math.sin(phi)
            return math.cos(phi) / math.sqrt(1.0 - self.e2 * s * s)

        def t(phi: float) -> float:
            s = math.sin(phi)
            return math.tan(math.pi / 4.0 - phi / 2.0) / pow(
                (1.0 - self.e * s) / (1.0 + self.e * s), self.e / 2.0
            )

        m1, m2 = m(phi1), m(phi2)
        t1, t2, t0 = t(phi1), t(phi2), t(phi0)
        self.n = (math.log(m1) - math.log(m2)) / (math.log(t1) - math.log(t2))
        self.F = m1 / (self.n * pow(t1, self.n))
        self.rho0 = self.a * self.F * pow(t0, self.n)

    def inv(self, x_ft: float, y_ft: float) -> Tuple[float, float]:
        x = x_ft * US_FT - self.FE
        y = y_ft * US_FT - self.FN
        rho = math.hypot(x, self.rho0 - y)
        if self.n < 0:
            rho = -rho
        theta = math.atan2(x, self.rho0 - y)
        t = pow(rho / (self.a * self.F), 1.0 / self.n)
        phi = math.pi / 2.0 - 2.0 * math.atan(t)
        for _ in range(12):
            s = math.sin(phi)
            phi_n = math.pi / 2.0 - 2.0 * math.atan(
                t * pow((1.0 - self.e * s) / (1.0 + self.e * s), self.e / 2.0)
            )
            if abs(phi_n - phi) < 1e-12:
                break
            phi = phi_n
        lam = self.lam0 + theta / self.n
        return (math.degrees(lam), math.degrees(phi))


# ── WKB (ISO LE/BE) LineString / MultiLineString ─────────────────────


def _u32(data: bytes, off: int, le: bool) -> int:
    return struct.unpack_from("<I" if le else ">I", data, off)[0]


def _f64(data: bytes, off: int, le: bool) -> float:
    return struct.unpack_from("<d" if le else ">d", data, off)[0]


def _geom_base_and_stride(gtype: int) -> Tuple[int, int]:
    """Return (base_type, coord_stride_bytes) for ISO / simple EWKB types."""
    # EWKB: high bits 0x80000000 Z, 0x40000000 M
    if gtype & 0x80000000 or gtype & 0x40000000:
        base = gtype & 0xFF
        dims = 2
        if gtype & 0x80000000:
            dims += 1
        if gtype & 0x40000000:
            dims += 1
        return base, 8 * dims
    # ISO: 1000=Z, 2000=M, 3000=ZM
    if gtype >= 1000:
        dim = gtype // 1000
        base = gtype % 1000
        stride = {0: 16, 1: 24, 2: 24, 3: 32}.get(dim, 16)
        return base, stride
    return gtype & 0xFF, 16


def wkb_to_xy_parts(wkb: bytes) -> List[List[Tuple[float, float]]]:
    """Return list of polylines (parts) as (x,y) in design CRS."""
    if not wkb or len(wkb) < 9:
        return []
    endian = wkb[0]
    if endian not in (0, 1):
        return []
    le = endian == 1
    gtype = _u32(wkb, 1, le)
    base, stride = _geom_base_and_stride(gtype)
    if base not in (2, 5):
        return []
    off = 5
    parts: List[List[Tuple[float, float]]] = []

    if base == 2:
        n = _u32(wkb, off, le)
        off += 4
        pts: List[Tuple[float, float]] = []
        for _ in range(n):
            if off + stride > len(wkb):
                break
            pts.append((_f64(wkb, off, le), _f64(wkb, off + 8, le)))
            off += stride
        if len(pts) >= 2:
            parts.append(pts)
        return parts

    # MultiLineString
    n_parts = _u32(wkb, off, le)
    off += 4
    for _ in range(n_parts):
        if off + 5 > len(wkb):
            break
        pe = wkb[off]
        off += 1
        if pe not in (0, 1):
            break
        ple = pe == 1
        pt = _u32(wkb, off, ple)
        off += 4
        pbase, pstride = _geom_base_and_stride(pt)
        if pbase != 2:
            break
        n = _u32(wkb, off, ple)
        off += 4
        pts = []
        for _k in range(n):
            if off + pstride > len(wkb):
                break
            pts.append((_f64(wkb, off, ple), _f64(wkb, off + 8, ple)))
            off += pstride
        if len(pts) >= 2:
            parts.append(pts)
    return parts


def parts_to_lonlat(
    parts: List[List[Tuple[float, float]]], crs: OkNorth, assume_2267: bool
) -> List[List[float]]:
    """Flatten parts to lonlat[] (concatenate; no seam markers in v1)."""
    out: List[List[float]] = []
    for part in parts:
        for x, y in part:
            if assume_2267:
                lon, lat = crs.inv(x, y)
            else:
                lon, lat = x, y
            out.append([lon, lat])
            if len(out) >= MAX_VERTS_EXPORT:
                return out
    return out


def norm_guid(g: Optional[str]) -> str:
    if not g:
        return ""
    return str(g).strip().lower()


def table_exists(con: sqlite3.Connection, name: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def export_path_index(
    design_db: str,
    out_root: str,
    *,
    limit: int = 0,
    write_sqlite: bool = True,
    assume_2267: bool = True,
    quiet: bool = False,
) -> Dict[str, Any]:
    con = sqlite3.connect(f"file:{os.path.abspath(design_db)}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row

    if not table_exists(con, "fiber_paths"):
        raise RuntimeError(
            "error: design DB has no fiber_paths table "
            "(run trace_fiber_paths.py / Tier A path walk first)"
        )
    n_paths = con.execute("SELECT COUNT(*) FROM fiber_paths").fetchone()[0]
    if n_paths == 0:
        raise RuntimeError("error: fiber_paths is empty — nothing to index")

    has_hops = table_exists(con, "fiber_path_hops")
    crs = OkNorth()

    out_dir = Path(out_root)
    idx_dir = out_dir / "path_index"
    idx_dir.mkdir(parents=True, exist_ok=True)

    sql = (
        "SELECT path_id, start_cable_guid, start_fiber, end_cable_guid, end_fiber, "
        "end_kind, hop_count, total_loss_db, has_drop, geom_wkb "
        "FROM fiber_paths ORDER BY path_id"
    )
    if limit > 0:
        sql += f" LIMIT {int(limit)}"

    paths_out: List[Dict[str, Any]] = []
    cable_to_paths: Dict[str, List[int]] = defaultdict(list)
    max_hop = 0
    hop_total = 0
    geom_missing = 0

    # Preload hops for selected paths if limited
    hops_by_path: Dict[int, List[sqlite3.Row]] = defaultdict(list)
    if has_hops:
        if limit > 0:
            ids = [r[0] for r in con.execute(
                f"SELECT path_id FROM fiber_paths ORDER BY path_id LIMIT {int(limit)}"
            )]
            if ids:
                qmarks = ",".join("?" * len(ids))
                for r in con.execute(
                    f"SELECT * FROM fiber_path_hops WHERE path_id IN ({qmarks}) "
                    "ORDER BY path_id, seq",
                    ids,
                ):
                    hops_by_path[int(r["path_id"])].append(r)
        else:
            for r in con.execute(
                "SELECT * FROM fiber_path_hops ORDER BY path_id, seq"
            ):
                hops_by_path[int(r["path_id"])].append(r)

    for row in con.execute(sql):
        pid = int(row["path_id"])
        hop_count = int(row["hop_count"] or 0)
        if hop_count > max_hop:
            max_hop = hop_count

        hops_rows = hops_by_path.get(pid, [])
        hops: List[Dict[str, Any]] = []
        for hr in hops_rows[:MAX_HOPS_EXPORT]:
            kind = (hr["hop_kind"] or "").lower()
            if kind == "cable":
                hops.append(
                    {
                        "seq": int(hr["seq"]),
                        "kind": "cable",
                        "cable_guid": norm_guid(hr["cable_guid"]),
                        "fiber": hr["fiber_number"],
                    }
                )
                g = norm_guid(hr["cable_guid"])
                if g and pid not in cable_to_paths[g]:
                    cable_to_paths[g].append(pid)
            else:
                hops.append(
                    {
                        "seq": int(hr["seq"]),
                        "kind": "equipment",
                        "sp_guid": norm_guid(hr["splicepoint_guid"]),
                        "station_id": hr["station_id"] or "",
                        "port_name": hr["port_name"] or "",
                        "port_name_type": hr["port_name_type"] or "",
                        "split_db": hr["split_db"],
                    }
                )
        hop_total += len(hops)

        # Also ensure start/end cables are in the map
        for g in (row["start_cable_guid"], row["end_cable_guid"]):
            ng = norm_guid(g)
            if ng and pid not in cable_to_paths[ng]:
                cable_to_paths[ng].append(pid)

        lonlat: List[List[float]] = []
        blob = row["geom_wkb"]
        if blob:
            parts = wkb_to_xy_parts(bytes(blob))
            lonlat = parts_to_lonlat(parts, crs, assume_2267)
        else:
            geom_missing += 1

        paths_out.append(
            {
                "path_id": pid,
                "start": {
                    "cable_guid": norm_guid(row["start_cable_guid"]),
                    "fiber": row["start_fiber"],
                },
                "end": {
                    "cable_guid": norm_guid(row["end_cable_guid"]),
                    "fiber": row["end_fiber"],
                },
                "end_kind": row["end_kind"] or "",
                "hop_count": hop_count,
                "total_loss_db": row["total_loss_db"],
                "has_drop": int(row["has_drop"] or 0),
                "lonlat": lonlat,
                "hops": hops,
            }
        )

    # Sort path id lists for stability
    cable_map = {k: sorted(v) for k, v in sorted(cable_to_paths.items())}

    meta = {
        "path_index_format": PATH_INDEX_FORMAT,
        "path_count": len(paths_out),
        "hop_count": hop_total,
        "cable_count": len(cable_map),
        "crs": "EPSG:4326",
        "source_crs": "EPSG:2267" if assume_2267 else "EPSG:4326",
        "max_hop_count": max_hop,
        "geom_missing": geom_missing,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    }

    (idx_dir / "meta.json").write_text(json.dumps(meta, indent=2) + "\n")
    (idx_dir / "cable_to_paths.json").write_text(
        json.dumps(cable_map, separators=(",", ":")) + "\n"
    )
    with (idx_dir / "paths.jsonl").open("w", encoding="utf-8") as f:
        for p in paths_out:
            f.write(json.dumps(p, separators=(",", ":")) + "\n")

    if write_sqlite:
        sqlite_path = out_dir / "path_index.sqlite"
        if sqlite_path.exists():
            sqlite_path.unlink()
        sdb = sqlite3.connect(str(sqlite_path))
        sdb.executescript(
            """
            CREATE TABLE path_meta (key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE paths (
              path_id INTEGER PRIMARY KEY,
              start_cable_guid TEXT,
              start_fiber INTEGER,
              end_cable_guid TEXT,
              end_fiber INTEGER,
              end_kind TEXT,
              hop_count INTEGER,
              total_loss_db REAL,
              has_drop INTEGER,
              lonlat_json TEXT
            );
            CREATE TABLE path_hops (
              path_id INTEGER NOT NULL,
              seq INTEGER NOT NULL,
              hop_kind TEXT NOT NULL,
              cable_guid TEXT,
              fiber_number INTEGER,
              sp_guid TEXT,
              station_id TEXT,
              port_name TEXT,
              split_db REAL
            );
            CREATE TABLE cable_paths (
              cable_guid TEXT NOT NULL,
              path_id INTEGER NOT NULL,
              PRIMARY KEY (cable_guid, path_id)
            );
            CREATE INDEX path_hops_path ON path_hops(path_id);
            CREATE INDEX cable_paths_path ON cable_paths(path_id);
            """
        )
        for k, v in meta.items():
            sdb.execute(
                "INSERT INTO path_meta(key,value) VALUES(?,?)", (k, str(v))
            )
        for p in paths_out:
            sdb.execute(
                "INSERT INTO paths VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    p["path_id"],
                    p["start"]["cable_guid"],
                    p["start"]["fiber"],
                    p["end"]["cable_guid"],
                    p["end"]["fiber"],
                    p["end_kind"],
                    p["hop_count"],
                    p["total_loss_db"],
                    p["has_drop"],
                    json.dumps(p["lonlat"], separators=(",", ":")),
                ),
            )
            for h in p["hops"]:
                if h["kind"] == "cable":
                    sdb.execute(
                        "INSERT INTO path_hops(path_id,seq,hop_kind,cable_guid,"
                        "fiber_number,sp_guid,station_id,port_name,split_db) "
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        (
                            p["path_id"],
                            h["seq"],
                            "cable",
                            h.get("cable_guid"),
                            h.get("fiber"),
                            None,
                            None,
                            None,
                            None,
                        ),
                    )
                else:
                    sdb.execute(
                        "INSERT INTO path_hops(path_id,seq,hop_kind,cable_guid,"
                        "fiber_number,sp_guid,station_id,port_name,split_db) "
                        "VALUES (?,?,?,?,?,?,?,?,?)",
                        (
                            p["path_id"],
                            h["seq"],
                            "equipment",
                            None,
                            None,
                            h.get("sp_guid"),
                            h.get("station_id"),
                            h.get("port_name"),
                            h.get("split_db"),
                        ),
                    )
        for cg, pids in cable_map.items():
            for pid in pids:
                sdb.execute(
                    "INSERT INTO cable_paths(cable_guid,path_id) VALUES(?,?)",
                    (cg, pid),
                )
        sdb.commit()
        sdb.close()

    # Annotate package manifest if present
    man_path = out_dir / "manifest.json"
    if man_path.is_file():
        man = json.loads(man_path.read_text())
        man["path_index"] = "path_index/"
        man["path_index_format"] = PATH_INDEX_FORMAT
        man["path_index_files"] = {
            "meta": "path_index/meta.json",
            "cable_to_paths": "path_index/cable_to_paths.json",
            "paths": "path_index/paths.jsonl",
        }
        if write_sqlite:
            man["path_index_sqlite"] = "path_index.sqlite"
        feats = man.get("features")
        if isinstance(feats, dict):
            feats["paths"] = len(paths_out)
        man_path.write_text(json.dumps(man, indent=2) + "\n")

    if not quiet:
        print(
            f"path_index: {len(paths_out)} paths, {len(cable_map)} cables, "
            f"max_hop={max_hop}, geom_missing={geom_missing} → {idx_dir}"
        )
    return meta


def self_test() -> int:
    """Synthetic design DB with 2 paths; verify browser files."""
    import tempfile

    crs = OkNorth()
    # Point near Tulsa in 2267 feet (approx from known lonlat)
    # Use forward is hard; invent feet coords and check inverse lands in OK-ish bbox
    lon0, lat0 = crs.inv(2_550_000.0, 350_000.0)
    assert -100 < lon0 < -94 and 33 < lat0 < 38, (lon0, lat0)

    # Build minimal MultiLineString WKB LE in 2267 feet
    def mls_wkb(parts: List[List[Tuple[float, float]]]) -> bytes:
        b = bytearray()
        b += b"\x01"  # LE
        b += struct.pack("<I", 5)  # MultiLineString
        b += struct.pack("<I", len(parts))
        for part in parts:
            b += b"\x01"
            b += struct.pack("<I", 2)  # LineString
            b += struct.pack("<I", len(part))
            for x, y in part:
                b += struct.pack("<dd", x, y)
        return bytes(b)

    geom = mls_wkb(
        [[(2_550_000.0, 350_000.0), (2_550_100.0, 350_050.0), (2_550_200.0, 350_100.0)]]
    )

    with tempfile.TemporaryDirectory() as td:
        dbp = Path(td) / "design.sqlite"
        con = sqlite3.connect(str(dbp))
        con.executescript(
            """
            CREATE TABLE fiber_paths (
              path_id INTEGER PRIMARY KEY,
              start_cable_guid TEXT,
              start_fiber INTEGER,
              end_cable_guid TEXT,
              end_fiber INTEGER,
              end_kind TEXT,
              hop_count INTEGER,
              equip_count INTEGER,
              total_loss_db REAL,
              has_drop INTEGER,
              work_orders TEXT,
              geom_wkb BLOB,
              geom_wkt TEXT
            );
            CREATE TABLE fiber_path_hops (
              hop_id INTEGER PRIMARY KEY AUTOINCREMENT,
              path_id INTEGER NOT NULL,
              seq INTEGER NOT NULL,
              hop_kind TEXT NOT NULL,
              cable_guid TEXT,
              fiber_number INTEGER,
              equipment_guid TEXT,
              port_name TEXT,
              port_name_type TEXT,
              splicepoint_guid TEXT,
              station_id TEXT,
              split_db REAL,
              work_order TEXT
            );
            """
        )
        g1 = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        g2 = "11111111-2222-3333-4444-555555555555"
        con.execute(
            "INSERT INTO fiber_paths VALUES (1,?,?,?,?,?,?,?,?,?,?,?,?)",
            (g1, 1, g2, 1, "drop", 2, 1, -1.5, 1, None, geom, None),
        )
        con.execute(
            "INSERT INTO fiber_paths VALUES (2,?,?,?,?,?,?,?,?,?,?,?,?)",
            (g2, 2, g2, 2, "through_end", 1, 0, 0.0, 0, None, geom, None),
        )
        con.executemany(
            "INSERT INTO fiber_path_hops(path_id,seq,hop_kind,cable_guid,"
            "fiber_number,equipment_guid,port_name,port_name_type,"
            "splicepoint_guid,station_id,split_db,work_order) "
            "VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
            [
                (1, 0, "cable", g1, 1, None, None, None, None, None, None, None),
                (
                    1,
                    1,
                    "equipment",
                    None,
                    None,
                    "eq1",
                    "Pass Through",
                    "pass_through",
                    "sp-guid-1",
                    "79-11-38",
                    -0.2,
                    None,
                ),
                (1, 2, "cable", g2, 1, None, None, None, None, None, None, None),
                (2, 0, "cable", g2, 2, None, None, None, None, None, None, None),
            ],
        )
        con.commit()
        con.close()

        out = Path(td) / "pkg"
        out.mkdir()
        (out / "manifest.json").write_text(
            json.dumps({"kind": "fiber", "format_version": 1}) + "\n"
        )
        meta = export_path_index(str(dbp), str(out), quiet=True)
        assert meta["path_count"] == 2
        c2p = json.loads((out / "path_index" / "cable_to_paths.json").read_text())
        assert g1 in c2p and 1 in c2p[g1]
        assert g2 in c2p
        lines = (out / "path_index" / "paths.jsonl").read_text().strip().splitlines()
        assert len(lines) == 2
        p0 = json.loads(lines[0])
        assert p0["path_id"] == 1
        assert len(p0["lonlat"]) >= 2
        lon, lat = p0["lonlat"][0]
        assert -100 < lon < -94 and 33 < lat < 38, (lon, lat)
        assert p0["hops"][0]["kind"] == "cable"
        man = json.loads((out / "manifest.json").read_text())
        assert man["path_index_format"] == 1
        assert (out / "path_index.sqlite").is_file()
        # fail-closed
        empty = Path(td) / "empty.sqlite"
        sqlite3.connect(str(empty)).close()
        try:
            export_path_index(str(empty), str(out / "x"), quiet=True)
            print("self-test FAIL: expected error on missing table", file=sys.stderr)
            return 1
        except RuntimeError:
            pass
    print("export_path_index self-test: OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("design_db", nargs="?", help="fiber_design.sqlite with fiber_paths")
    ap.add_argument("-o", "--out", help="Package root (writes path_index/ under it)")
    ap.add_argument("--limit", type=int, default=0, help="Max paths (0=all)")
    ap.add_argument(
        "--no-sqlite",
        action="store_true",
        help="Skip path_index.sqlite dual emit",
    )
    ap.add_argument(
        "--wgs84-input",
        action="store_true",
        help="Treat geom_wkb as already WGS84 lon/lat (skip EPSG:2267 inverse)",
    )
    ap.add_argument("-q", "--quiet", action="store_true")
    ap.add_argument(
        "--self-test",
        action="store_true",
        help="Run synthetic fixture test and exit",
    )
    args = ap.parse_args()

    if args.self_test:
        return self_test()

    if not args.design_db or not args.out:
        ap.error("design_db and -o/--out required (or use --self-test)")

    if not os.path.isfile(args.design_db):
        print(f"error: design db not found: {args.design_db}", file=sys.stderr)
        return 1

    try:
        export_path_index(
            args.design_db,
            args.out,
            limit=args.limit,
            write_sqlite=not args.no_sqlite,
            assume_2267=not args.wgs84_input,
            quiet=args.quiet,
        )
    except RuntimeError as e:
        print(str(e), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
