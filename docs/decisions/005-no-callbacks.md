# ADR-005: No Callbacks

## Status

Accepted

## Date

2026-07-15

## Context

Callback-driven map libraries complicate WASM and event-loop embedding.

## Decision

All notifications use the pull event queue. No user function pointers in the
public API. (Inherited from sibling libraries.)

## Consequences

- Simple reentrancy rules; uniform with libbmp/libdom

## Alternatives considered

- Observer callbacks — rejected
