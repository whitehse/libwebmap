#!/usr/bin/env python3
"""
Export compact per-splicepoint connectivity JSON for the fiber hover magnifier.

Reads fiber_design.sqlite (export_fiber_design output) and writes one JSON file
per splicepoint under OUTDIR/<guid>.json.

Schema v1 — see docs/guides/fiber-map-data.md and ADR-016.

Usage:
  # Prefer the package recipe (sets relative splice_detail_url on the manifest):
  #   FIBER_DESIGN_DB=/path/to/fiber_design.sqlite ./tools/build_fiber_package.sh

  python3 tools/export_splice_detail.py \\
    \"$FIBER_DESIGN_DB\" \\
    -o demo/fiber_data/splice_detail

  # Only SPs that appear in an existing features.sqlite map export:
  python3 tools/export_splice_detail.py \"$FIBER_DESIGN_DB\" -o out \\
    --map-db demo/fiber_data/features.sqlite \\
    --manifest demo/fiber_data/manifest.json
"""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple

NIL = "00000000-0000-0000-0000-000000000000"


def connect_ro(path: str) -> sqlite3.Connection:
    uri = f"file:{os.path.abspath(path)}?mode=ro"
    con = sqlite3.connect(uri, uri=True)
    con.row_factory = sqlite3.Row
    return con


def table_exists(con: sqlite3.Connection, name: str) -> bool:
    row = con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone()
    return row is not None


def load_drop_cables(con: sqlite3.Connection) -> Set[str]:
    """Cable guids that terminate on a drop port (same rule as fiber2features)."""
    if not table_exists(con, "ports"):
        return set()
    rows = con.execute(
        """
        SELECT DISTINCT patch_guid AS guid
        FROM ports
        WHERE port_name_type = 'drop'
          AND patch_guid IS NOT NULL
          AND patch_guid != ?
        """,
        (NIL,),
    ).fetchall()
    # Also: cable parents that are the drop side? fiber2features uses:
    # CREATE TEMP TABLE _drop_cables AS SELECT DISTINCT p.patch_guid ...
    # Actually it marks cables that ARE the drop cable via join on cable guid
    # from ports where port_name_type = drop on equipment, patch_guid = cable.
    out = {r["guid"] for r in rows if r["guid"]}
    # Alternate: cables that appear as parent of nothing but are linked from drop
    # Already covered: patch_guid from drop ports points at drop cable.
    return out


def load_map_sp_guids(map_db: str) -> Optional[Set[str]]:
    if not map_db:
        return None
    con = connect_ro(map_db)
    guids: Set[str] = set()
    if table_exists(con, "map_taps"):
        for r in con.execute(
            "SELECT sp_guid FROM map_taps WHERE sp_guid IS NOT NULL AND sp_guid != ''"
        ):
            guids.add(r["sp_guid"])
    if table_exists(con, "map_splices"):
        for r in con.execute(
            "SELECT sp_guid FROM map_splices WHERE sp_guid IS NOT NULL AND sp_guid != ''"
        ):
            guids.add(r["sp_guid"])
    con.close()
    return guids


def build_detail(
    con: sqlite3.Connection,
    sp_guid: str,
    drop_cables: Set[str],
) -> Dict[str, Any]:
    station = ""
    if table_exists(con, "splicepoints"):
        row = con.execute(
            "SELECT station_id FROM splicepoints WHERE guid=?", (sp_guid,)
        ).fetchone()
        if row and row["station_id"]:
            station = row["station_id"]

    # Cables at this SP
    cables: List[Dict[str, Any]] = []
    cable_sizes: Dict[str, int] = {}
    if table_exists(con, "cable_at_splice"):
        for r in con.execute(
            """
            SELECT cas.cable_guid, cas.fiber_count, c.cable_size
            FROM cable_at_splice cas
            LEFT JOIN cables c ON c.guid = cas.cable_guid
            WHERE cas.splicepoint_guid = ?
            ORDER BY cas.cable_guid
            """,
            (sp_guid,),
        ):
            guid = r["cable_guid"]
            size = r["cable_size"] or r["fiber_count"] or 0
            cable_sizes[guid] = int(size)
            cables.append(
                {
                    "guid": guid,
                    "size": int(size),
                    "is_drop": guid in drop_cables,
                }
            )

    # Equipment / tap
    tap: Optional[Dict[str, Any]] = None
    equip_guids: List[str] = []
    if table_exists(con, "equipment"):
        for r in con.execute(
            """
            SELECT guid, is_tap, tap_loss_db, tap_ports
            FROM equipment
            WHERE splicepoint_guid = ?
            """,
            (sp_guid,),
        ):
            equip_guids.append(r["guid"])
            if r["is_tap"]:
                tap = {
                    "name": None,
                    "ports": int(r["tap_ports"] or 0),
                    "loss_db": r["tap_loss_db"],
                    "in_tube": None,
                    "in_strand": None,
                    "out_tube": None,
                    "out_strand": None,
                    "equip_guid": r["guid"],
                }

    if tap and table_exists(con, "equipment_disp"):
        d = con.execute(
            """
            SELECT name, tap_ports, fiber_tube_color, fiber_strand_color,
                   out_tube_color, out_strand_color, station_id
            FROM equipment_disp
            WHERE splicepoint_guid = ?
            LIMIT 1
            """,
            (sp_guid,),
        ).fetchone()
        if d:
            tap["name"] = d["name"] or tap["name"]
            if d["tap_ports"] is not None:
                tap["ports"] = int(d["tap_ports"])
            tap["in_tube"] = d["fiber_tube_color"] or None
            tap["in_strand"] = d["fiber_strand_color"] or None
            tap["out_tube"] = d["out_tube_color"] or None
            tap["out_strand"] = d["out_strand_color"] or None
            if d["station_id"] and not station:
                station = d["station_id"]

    links: List[Dict[str, Any]] = []
    seen_fuse: Set[Tuple[str, int, str, int]] = set()

    # Equipment ports → ingress / egress / drop
    if table_exists(con, "ports"):
        for r in con.execute(
            """
            SELECT parent_guid, number, name, port_name_type, port_name_number,
                   patch_guid, patch_number, split_db
            FROM ports
            WHERE splicepoint_guid = ?
              AND parent_type = 'equipment'
            ORDER BY number, port_name_type
            """,
            (sp_guid,),
        ):
            role_raw = (r["port_name_type"] or "").lower()
            patch = r["patch_guid"] or NIL
            if patch == NIL:
                # still emit unpatched drop ports as empty drops
                if role_raw == "drop":
                    links.append(
                        {
                            "role": "drop",
                            "a": None,
                            "b": None,
                            "port": r["name"] or f"Drop {r['port_name_number'] or ''}",
                            "loss_db": r["split_db"],
                            "drop_port": r["port_name_number"],
                        }
                    )
                continue

            fiber = int(r["patch_number"] or 0)
            cable = patch
            # equipment patches to cable fibers
            endpoint = {"cable": cable, "fiber": fiber} if fiber > 0 else None

            if role_raw == "input":
                links.append(
                    {
                        "role": "ingress",
                        "a": endpoint,
                        "b": None,
                        "port": r["name"] or "Input",
                        "loss_db": r["split_db"] or 0,
                    }
                )
            elif role_raw in ("pass_through", "passthrough", "through"):
                links.append(
                    {
                        "role": "egress",
                        "a": endpoint,
                        "b": None,
                        "port": r["name"] or "Pass Through",
                        "loss_db": r["split_db"],
                    }
                )
            elif role_raw == "drop":
                links.append(
                    {
                        "role": "drop",
                        "a": endpoint,
                        "b": None,
                        "port": r["name"] or f"Drop {r['port_name_number'] or ''}",
                        "loss_db": r["split_db"],
                        "drop_port": r["port_name_number"],
                    }
                )
            else:
                links.append(
                    {
                        "role": "equip",
                        "a": endpoint,
                        "b": None,
                        "port": r["name"] or role_raw or None,
                        "loss_db": r["split_db"],
                    }
                )

        # Cable↔cable fuse: cable ports patched to other cables
        for r in con.execute(
            """
            SELECT parent_guid, number, patch_guid, patch_number, name
            FROM ports
            WHERE splicepoint_guid = ?
              AND parent_type = 'cable'
              AND patch_guid IS NOT NULL
              AND patch_guid != ?
            """,
            (sp_guid, NIL),
        ):
            a_c = r["parent_guid"]
            a_f = int(r["number"] or 0)
            b_c = r["patch_guid"]
            b_f = int(r["patch_number"] or 0)
            # Skip equipment patches (those are ingress/egress/drop already)
            if b_c in equip_guids or a_c in equip_guids:
                continue
            # Only cable-to-cable
            if b_f <= 0 or a_f <= 0:
                continue
            # If patch target is equipment, skip
            # (equip guids known)
            key = tuple(sorted([(a_c, a_f), (b_c, b_f)]))
            # normalize undirected
            k2 = (key[0][0], key[0][1], key[1][0], key[1][1])
            if k2 in seen_fuse:
                continue
            seen_fuse.add(k2)
            links.append(
                {
                    "role": "fuse",
                    "a": {"cable": a_c, "fiber": a_f},
                    "b": {"cable": b_c, "fiber": b_f},
                    "port": r["name"],
                    "loss_db": 0,
                }
            )

    # connections table fallback for fuse pairs not captured above
    if table_exists(con, "connections"):
        for r in con.execute(
            """
            SELECT from_type, from_guid, from_number, from_name,
                   to_type, to_guid, to_number, splice_type, split_db
            FROM connections
            WHERE splicepoint_guid = ?
              AND from_type = 'cable' AND to_type = 'cable'
            """,
            (sp_guid,),
        ):
            a_c, a_f = r["from_guid"], int(r["from_number"] or 0)
            b_c, b_f = r["to_guid"], int(r["to_number"] or 0)
            if a_f <= 0 or b_f <= 0:
                continue
            key = tuple(sorted([(a_c, a_f), (b_c, b_f)]))
            k2 = (key[0][0], key[0][1], key[1][0], key[1][1])
            if k2 in seen_fuse:
                continue
            seen_fuse.add(k2)
            links.append(
                {
                    "role": "fuse",
                    "a": {"cable": a_c, "fiber": a_f},
                    "b": {"cable": b_c, "fiber": b_f},
                    "port": r["from_name"],
                    "loss_db": r["split_db"] or 0,
                }
            )

    kind = "tap" if tap else "splice"
    return {
        "v": 1,
        "guid": sp_guid,
        "station_id": station or "",
        "kind": kind,
        "tap": tap,
        "cables": cables,
        "links": links,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("design_db", help="fiber_design.sqlite path")
    ap.add_argument(
        "-o",
        "--out",
        required=True,
        help="Output directory for <guid>.json files",
    )
    ap.add_argument(
        "--map-db",
        default=None,
        help="Optional features.sqlite — only export SPs present on the map",
    )
    ap.add_argument(
        "--limit",
        type=int,
        default=0,
        help="Max SPs to export (0 = all)",
    )
    ap.add_argument(
        "--manifest",
        default=None,
        help="Optional fiber_data/manifest.json to annotate splice_detail_url",
    )
    args = ap.parse_args()

    if not os.path.isfile(args.design_db):
        print(f"error: design db not found: {args.design_db}", file=sys.stderr)
        return 1

    os.makedirs(args.out, exist_ok=True)
    con = connect_ro(args.design_db)
    drop_cables = load_drop_cables(con)
    map_guids = load_map_sp_guids(args.map_db) if args.map_db else None

    # Candidate SPs
    sp_list: List[str] = []
    if map_guids is not None:
        sp_list = sorted(map_guids)
    elif table_exists(con, "cable_at_splice"):
        sp_list = [
            r[0]
            for r in con.execute(
                "SELECT DISTINCT splicepoint_guid FROM cable_at_splice ORDER BY 1"
            )
        ]
    elif table_exists(con, "splicepoints"):
        sp_list = [
            r[0] for r in con.execute("SELECT guid FROM splicepoints ORDER BY 1")
        ]
    else:
        print("error: no splicepoints / cable_at_splice tables", file=sys.stderr)
        return 1

    if args.limit > 0:
        sp_list = sp_list[: args.limit]

    n_ok = 0
    n_tap = 0
    n_links = 0
    for i, guid in enumerate(sp_list):
        detail = build_detail(con, guid, drop_cables)
        path = os.path.join(args.out, f"{guid}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(detail, f, separators=(",", ":"))
        n_ok += 1
        if detail.get("kind") == "tap":
            n_tap += 1
        n_links += len(detail.get("links") or [])
        if (i + 1) % 2000 == 0:
            print(f"  … {i + 1}/{len(sp_list)}", file=sys.stderr)

    con.close()
    print(
        f"wrote {n_ok} detail files → {args.out} "
        f"(taps={n_tap}, total_links={n_links}, drops_marked={len(drop_cables)})"
    )

    if args.manifest and os.path.isfile(args.manifest):
        with open(args.manifest, encoding="utf-8") as f:
            man = json.load(f)
        # Path relative to the fiber_data baseUrl the demo passes to
        # loadPyramid (e.g. "./fiber_data"). The host joins this with
        # baseUrl — do NOT write page-root "./splice_detail/" alone (404).
        man["splice_detail_url"] = "./splice_detail/"
        with open(args.manifest, "w", encoding="utf-8") as f:
            json.dump(man, f, indent=2)
            f.write("\n")
        print(f"updated manifest: {args.manifest}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
