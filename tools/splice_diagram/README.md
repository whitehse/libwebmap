# splice_diagram

Host tool: **fiber design SQLite → self-contained HTML splice diagrams**.

Reads a Tier A intermediate design DB (`fiber_design.sqlite` schema; see
[fiber-design-input.md](../../docs/formats/fiber-design-input.md)) and writes
one HTML page per splicepoint that has equipment/ports. Filenames match
`fiber2features` diagram attributes:

```
sp_<station_or_guid>_<guid8>.html
```

## Build

```bash
cmake -B build -S .
cmake --build build --target splice_diagram
```

Uses the same vendored SQLite amalgamation as `fiber2features`.

## Generate into demo

Diagrams are large (~GB) and **not committed**. Generate a real directory
(not a symlink):

```bash
# Via CMake (recommended)
cmake -B build -S . -DFIBER_DESIGN_DB=/path/to/fiber_design.sqlite
cmake --build build --target splice_diagrams
# → demo/splice_diagrams/*.html + index.html

# Or CLI
./build/splice_diagram --all -o demo/splice_diagrams /path/to/fiber_design.sqlite
```

`tools/build_fiber_package.sh` also generates diagrams when
`FIBER_DESIGN_DB` is set (unless `SKIP_DIAGRAMS=1`).

## CLI

```bash
./build/splice_diagram --all -o demo/splice_diagrams fiber_design.sqlite
./build/splice_diagram -g <guid> -o one.html fiber_design.sqlite
./build/splice_diagram -s 78-05-14 -o one.html fiber_design.sqlite
./build/splice_diagram --all --limit 20 -o /tmp/diags fiber_design.sqlite
```

Options: `--show-dark`, `--compact`, `--no-paths`, `--max-paths N`,
`--view splicer|trace`.

## Library API

`splice_diagram.h` exposes `sd_open` / `sd_render` / `sd_diagram_filename` /
`sd_foreach_splicepoint` for embedding (e.g. a future host HTTP path). The
CLI is the primary product for the WebGPU demo package.
