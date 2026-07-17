#!/usr/bin/env python3
"""Smoke-parse fixtures/fiber_path_trace sample_v2.fmap and sample_v3.fmap.

Mirrors demo/display/fiber_fmap.js layout (docs/formats/fmap.md).
Exit 0 on success.
"""
from __future__ import annotations

import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "fixtures" / "fiber_path_trace"
MAGIC = 0x50414D46
NIL = "00000000-0000-0000-0000-000000000000"

CABLE_A = "aabbccdd-1122-3344-5566-77889900aabb"
CABLE_B = "00112233-4455-6677-8899-aabbccddeeff"


def guid_str(b: bytes) -> str:
    h = b.hex()
    s = f"{h[0:8]}-{h[8:12]}-{h[12:16]}-{h[16:20]}-{h[20:32]}"
    return "" if s == NIL else s


def parse_fmap(data: bytes) -> dict:
    if len(data) < 36:
        raise ValueError("too short")
    magic, ver = struct.unpack_from("<II", data, 0)
    if magic != MAGIC:
        raise ValueError("bad magic")
    if ver not in (1, 2, 3):
        raise ValueError(f"bad version {ver}")
    z = data[8]
    x, y, extent = struct.unpack_from("<III", data, 12)
    n_c, n_d, n_t = struct.unpack_from("<III", data, 24)
    off = 36
    n_s = 0
    if ver >= 2:
        n_s = struct.unpack_from("<I", data, 36)[0]
        off = 40

    # Mutable offset for nested readers
    box = [off]

    def read_lines(n: int):
        out = []
        o = box[0]
        for _ in range(n):
            n_pts, size, rgba = struct.unpack_from("<HHI", data, o)
            o += 8
            cable_guid = ""
            if ver >= 3:
                cable_guid = guid_str(data[o : o + 16])
                o += 16
            pts = []
            for _k in range(n_pts):
                px, py = struct.unpack_from("<ff", data, o)
                pts.append((px, py))
                o += 8
            out.append(
                {
                    "n_pts": n_pts,
                    "size": size,
                    "rgba": rgba,
                    "cable_guid": cable_guid,
                    "pts": pts,
                }
            )
        box[0] = o
        return out

    cables = read_lines(n_c)
    drops = read_lines(n_d)
    o = box[0]
    taps = []
    for _ in range(n_t):
        rec = 36 if ver >= 2 else 20
        tx, ty = struct.unpack_from("<ff", data, o)
        ports = data[o + 8]
        strand, tube = struct.unpack_from("<II", data, o + 12)
        sp = guid_str(data[o + 20 : o + 36]) if ver >= 2 else ""
        taps.append({"x": tx, "y": ty, "ports": ports, "sp_guid": sp})
        o += rec
    splices = []
    for _ in range(n_s):
        sx, sy, rgba = struct.unpack_from("<ffI", data, o)
        sp = guid_str(data[o + 12 : o + 28])
        splices.append({"x": sx, "y": sy, "rgba": rgba, "sp_guid": sp})
        o += 28
    return {
        "version": ver,
        "z": z,
        "x": x,
        "y": y,
        "extent": extent,
        "cables": cables,
        "drops": drops,
        "taps": taps,
        "splices": splices,
    }


def main() -> int:
    v2p = FIX / "sample_v2.fmap"
    v3p = FIX / "sample_v3.fmap"
    if not v2p.is_file() or not v3p.is_file():
        print("missing fixtures under fixtures/fiber_path_trace/", file=sys.stderr)
        return 1

    v2 = parse_fmap(v2p.read_bytes())
    assert v2["version"] == 2
    assert len(v2["cables"]) == 1 and v2["cables"][0]["cable_guid"] == ""
    assert len(v2["drops"]) == 1 and v2["drops"][0]["cable_guid"] == ""
    assert v2["cables"][0]["size"] == 72
    assert abs(v2["cables"][0]["pts"][0][0] - 100.0) < 1e-3
    assert v2["taps"][0]["ports"] == 4
    assert v2["taps"][0]["sp_guid"].startswith("deadbeef")

    v3 = parse_fmap(v3p.read_bytes())
    assert v3["version"] == 3
    assert v3["cables"][0]["cable_guid"] == CABLE_A
    assert v3["drops"][0]["cable_guid"] == CABLE_B
    assert v3["cables"][0]["n_pts"] == 2
    assert len(v3["splices"]) == 1

    print("test_fmap_parse: OK (v2 + v3 fixtures)")
    return 0


if __name__ == "__main__":
    # silence unused inner helper lint if any
    raise SystemExit(main())
