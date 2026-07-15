# ADR-007: WebGPU-Oriented GPU Buffers

## Status

Accepted

## Date

2026-07-15

## Context

The product target is a performant web map on modern browsers. WebGPU is the
chosen graphics API (aligned with maplibre-rs direction). Embedding wgpu-native
or dawn inside this library would explode dependencies.

## Decision

libwebmap produces **WebGPU-friendly data**:

- Interleaved `webmap_vertex_t` (`float2` position + packed RGBA)
- 32-bit index buffers
- Layer metadata (kind, class, extent, name)

The **host** creates `GPUDevice`, pipelines, and `GPUBuffer` objects and uploads
library-owned CPU buffers. No WebGPU C calls inside libwebmap.

## Consequences

- Small core; works with browser WebGPU and native wgpu equally

## Alternatives considered

- WebGL-only path — rejected as primary; WebGPU is the design center
- In-process Dawn/wgpu — rejected for dependency weight
