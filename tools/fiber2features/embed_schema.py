#!/usr/bin/env python3
"""Regenerate schema_map_sql.c from tools/schema/schema_map.sql."""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SQL = ROOT / "tools" / "schema" / "schema_map.sql"
OUT = Path(__file__).resolve().parent / "schema_map_sql.c"


def main() -> int:
    sql = SQL.read_text()
    lines = [
        "/* Auto-generated from tools/schema/schema_map.sql — do not edit. */",
        "/* Regenerate: python3 tools/fiber2features/embed_schema.py */",
        "#include <stddef.h>",
        "",
        "const char webmap_schema_map_sql[] =",
    ]
    for line in sql.splitlines(True):
        esc = (
            line.replace("\\", "\\\\")
            .replace('"', '\\"')
            .replace("\r", "\\r")
            .replace("\n", "\\n")
            .replace("\t", "\\t")
        )
        lines.append(f'    "{esc}"')
    lines.append(";")
    lines.append(
        "const size_t webmap_schema_map_sql_len = sizeof(webmap_schema_map_sql) - 1;"
    )
    lines.append("")
    OUT.write_text("\n".join(lines) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
