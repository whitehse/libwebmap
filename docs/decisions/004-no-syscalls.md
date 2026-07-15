# ADR-004: No Syscalls / Host I/O

## Status

Accepted

## Date

2026-07-15

## Context

Browser WASM and high-performance hosts own fetch, filesystem, and GPU.
Embedding I/O would force Emscripten-style shims and break freestanding builds.

## Decision

libwebmap core performs **no** syscalls: no sockets, files, clocks, or dynamic
loading. Allocation uses standard `malloc`/`calloc`/`free`/`realloc` at create
and for bounded tile/overlay storage. The caller feeds `.wmap` bytes and overlay
descriptors. (Inherited sibling contract.)

The **host tool** `gfvtile2wmap` may use stdio; it is not part of the core library
link for WASM.

## Consequences

- Fully testable with synthetic buffers; portable WASM

## Alternatives considered

- Built-in HTTP tile client — rejected; host/CDN responsibility
