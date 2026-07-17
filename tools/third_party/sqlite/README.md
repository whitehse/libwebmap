# SQLite amalgamation (host tools only)

Vendored for `fiber2features` (and future host tools that need SQLite).

- **Not** linked into `webmap.wasm` / freestanding builds.
- Source: SQLite amalgamation (`sqlite3.c` / `sqlite3.h`), same copy as used by
  crescentlink_export for consistent tooling on this machine.
- Compiled with warnings suppressed (`-w`) so amalgamation noise does not break
  `-Werror` builds.

Do not use system `libsqlite3` for the fiber baker without an intentional ADR.
