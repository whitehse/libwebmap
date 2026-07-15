# ADR-009: Do Not Use Emscripten to Compile WASM

## Status

Accepted

## Date

2026-07-15

## Context

Emscripten is a common C/C++→WASM toolchain but pulls a large sysroot, custom
JS glue, and non-standard CMake integration (`emcmake`). Sibling libraries prefer
minimal, auditable builds. This project explicitly targets a **standard CMake +
clang** WASM pipeline.

## Decision

**Emscripten shall not be used** to compile libwebmap or its WASM artifacts.

Forbidden in-tree:

- `emcc`, `em++`, `emcmake`, `embuilder`
- Emscripten toolchain files or `EMSCRIPTEN` root dependencies
- Shipping Emscripten-generated JS glue as the supported load path

Allowed:

- `clang --target=wasm32` (or `wasm32-unknown-unknown` / WASI with documented sysroot)
- `wasm-ld` (LLD)
- Standard CMake with `cmake/WasmToolchain.cmake`
- Optional thin host imports for `malloc` / WASI libc **without** Emscripten

## Consequences

- Smaller, clearer build story; more work for freestanding libc/math
- Documentation and CI must never recommend Emscripten workarounds

## Alternatives considered

- Emscripten for convenience — **rejected** by product decision
- Zig cc as sole WASM driver — optional later; not required; still not Emscripten
