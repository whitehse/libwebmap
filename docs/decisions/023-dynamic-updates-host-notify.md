# ADR-023: Dynamic updates via host feed (NOTIFY / WS / fixture)

## Status

Accepted

## Date

2026-07-18

## Context

Program design places Postgres `LISTEN`/`NOTIFY` and edgehost WebSocket
fan-out **outside** libwebmap (ADR-004, ADR-017). The SPA still needs an
offline path to exercise `map.dynamic` status updates without edgehost
(P1.12). Track 4 **P4.9** delivers that consumer.

## Decision

1. **Host module** `demo/display/dynamic_feed.js`:
   - Validates NOTIFY-shaped JSON (`v`, `op`, `ns`, `key`, `value`) and
     edgehost `STATE_CHANGED` envelopes.
   - Allowlist: namespace **`map.dynamic` only** for v1 demo paint/store.
   - Max payload **8000** bytes (program `notify_max_payload`).
   - Drops: bad JSON, `v ≠ 1`, unknown `op`, non-allowlisted `ns`, oversized.
2. **Offline default:** play `demo/dynamic/sample_events.jsonl` (JSONL).
   Optional pace via `?feed_interval=ms` (default 900).
3. **Live path:** `?feed=ws://…` or `wss://…` — browser `WebSocket`; no
   reconnect/backoff in v1 (edgehost production will add reconnect).
4. **Disable:** `?feed=0`.
5. **Paint:** host WebGPU meshes for values with GeoJSON `geom` or
   `lon`/`lat`. `geom_ref` alone is store/HUD-only (weather package owns
   static paint). Status colors from `GLASS_STATUS` / `webmap_status_rgba`.
6. **No C/WASM change** for P4.9. Production C hosts may later map the same
   schema onto `webmap_upsert_overlay`.

## Consequences

- Demo shows a paced fiber span status change (ok→degraded→down) and alert
  geometries without a server.
- Metrics (`applied`, `bad_payload`, `ns_drop`) surface in the sidebar HUD.
- Edgehost P1.12 remains the production NOTIFY→WS path; this ADR does not
  implement Postgres.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Poll REST only | WS is the SPA contract; fixture covers offline |
| Put NOTIFY client in WASM | Violates ADR-004 / NG4 |
| Block demo on edgehost | P4.9 must be independently mergeable |

## Related

- Program design § Dynamic updates (NOTIFY); Key Decision 10  
- [ADR-014](014-plumbing-vs-host-renderer.md), [ADR-017](017-three-tier-data-boundary.md)  
- [ADR-022](022-weather-package-host-paint.md) — related host paint  
