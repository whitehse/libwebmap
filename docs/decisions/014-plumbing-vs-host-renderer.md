# ADR-014: Plumbing vs Host Renderer Boundary

## Status

Accepted

## Date

2026-07-15

## Context

Sibling “plumbing” libraries avoid policy and I/O. A map engine must still
avoid becoming a full browser stack.

## Decision

**In library:** projection, tile cache, overlay store, format codecs, GPU buffer
packing, event queue.

**In host:** network, filesystem (except the offline tool), WebGPU/wgpu device,
shaders, input gestures, auth, persistence.

This is the map-specific restatement of the sibling “core as plumbing” rule.

## Consequences

- Testable core; swappable hosts (dashboard, kiosk, native)

## Alternatives considered

- Full engine with embedded renderer — deferred indefinitely
