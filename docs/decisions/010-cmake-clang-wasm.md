# ADR-010: CMake + Clang WASM Toolchain

## Status

Accepted

## Date

2026-07-15

## Context

Given ADR-009, WASM builds need a concrete non-Emscripten path consistent with
native sibling libraries that already use CMake.

## Decision

- Native and WASM builds use **CMake ≥ 3.20**
- C compiler is **clang** for WASM (`CMAKE_C_COMPILER_TARGET` / `-target wasm32`)
- Linker is **wasm-ld** (LLD)
- Toolchain file: `cmake/WasmToolchain.cmake`
- Options: `WEBMAP_BUILD_WASM`, `WEBMAP_BUILD_TOOLS`, `WEBMAP_BUILD_TESTS`

Native default remains any C11 compiler (clang/gcc) with `-Wall -Wextra -Wpedantic -Werror`.

## Consequences

- One project model for agents; WASM is an option, not a fork

## Alternatives considered

- Hand-written Makefiles only — rejected; inconsistent with siblings
