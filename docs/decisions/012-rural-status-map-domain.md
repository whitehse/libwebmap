# ADR-012: Rural Fiber + Electric Status Map Domain

## Status

Accepted

## Date

2026-07-15

## Context

The primary deployment is operations visibility for a rural ISP / electric
utility footprint where most customers have **both** fiber and electric service.
Sibling projects under `~/` produce dynamic telemetry (forensics, CPE, inventory).

## Decision

First-class feature classes and statuses model that domain:

- Fiber: span, node, CPE
- Electric: line, pole, substation, outage zone
- Shared: customer, alert
- Status: unknown, ok, degraded, down, maint

Overlays are upserted by stable ids from upstream systems; basemap remains
general OSM-derived geometry via GeoFabrik tiles.

## Consequences

- API and colors encode ops semantics, not only generic GIS

## Alternatives considered

- Generic GeoJSON layer only — rejected as insufficient product framing
