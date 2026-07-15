# ADR-013: Strict Compiler Warnings

## Status

Accepted

## Date

2026-07-15

## Context

Sibling libraries compile with `-Wall -Wextra -Wpedantic -Werror`.

## Decision

Same flags for libwebmap native and WASM C builds (non-MSVC).

## Consequences

- Cleaner code; agents must keep builds warning-free

## Alternatives considered

- Warnings as warnings only — rejected
