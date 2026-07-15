# ADR-002: Pure C Choice

## Status

Accepted

## Date

2026-07-15

## Context

libwebmap must embed beside pure-C siblings, compile to WASM without a heavy
runtime, and remain FFI-friendly for JS and other hosts.

## Decision

Implement libwebmap in pure C11 with no required external dependencies beyond
the C standard library and libm for projection math on native targets.
(Inherited from the sibling library set; same rationale as libbmp ADR-001.)

## Consequences

- Trivial static linking; no C++ runtime; consistent with ecosystem

## Alternatives considered

- C++17 / Rust — rejected for sibling consistency (maplibre-rs inspires structure only)
