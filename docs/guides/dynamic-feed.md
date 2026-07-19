# Dynamic feed (`map.dynamic`) — demo host

**P4.9 / ADR-023.** Offline fixture + optional WebSocket consumer for
operational status overlays. Does **not** require edgehost or Postgres.

| Asset | Role |
|-------|------|
| [demo/display/dynamic_feed.js](../../demo/display/dynamic_feed.js) | Parser, store, fixture player, WS, GPU paint |
| [demo/dynamic/sample_events.jsonl](../../demo/dynamic/sample_events.jsonl) | Served fixture |
| [fixtures/dynamic/](../../fixtures/dynamic/) | Canonical fixtures + WS envelope sample |

## Query params

| Param | Effect |
|-------|--------|
| (default) | Load `./dynamic/sample_events.jsonl`, pace 900 ms |
| `?feed=0` | Disable |
| `?feed=./path.jsonl` | Custom JSONL URL |
| `?feed=ws://host/api/v1/stream` | Live WebSocket |
| `?feed_interval=0` | Apply entire fixture immediately |
| `?feed_interval=400` | ms between fixture events |

## Message shapes

### NOTIFY / fixture line

```json
{
  "v": 1,
  "op": "upsert",
  "ns": "map.dynamic",
  "key": "feature/fiber/span-1842",
  "value": {
    "id": "span-1842",
    "class": "fiber",
    "status": "down",
    "updated_at": "2026-07-18T12:00:00Z",
    "geom": { "type": "LineString", "coordinates": [[-95.99, 36.12], [-95.93, 36.15]] }
  }
}
```

| Field | Notes |
|-------|-------|
| `op` | `upsert`/`put` or `remove`/`delete` |
| `ns` | Only `map.dynamic` applied (others metric-dropped) |
| `value.status` | `ok` / `degraded` / `down` / `maint` / `unknown` |
| `value.geom` | GeoJSON Point / LineString / Polygon → host mesh |
| `value.lon`+`lat` | Point fallback without GeoJSON |
| `value.geom_ref` | Store/HUD only (e.g. `weather:ice-zone-1`) |

Max serialized size: **8000** bytes.

### Edgehost WS envelope

```json
{
  "type": "STATE_CHANGED",
  "ns": "map.dynamic",
  "key": "feature/fiber/span-1842",
  "op": "put",
  "value": { "id": "span-1842", "class": "fiber", "status": "down", "updated_at": "..." },
  "request_id": "01J..."
}
```

See [fixtures/dynamic/sample_ws_envelope.jsonl](../../fixtures/dynamic/sample_ws_envelope.jsonl).

## Validation drops

| Failure | Metric |
|---------|--------|
| JSON / `v` ≠ 1 / bad key / unknown op / oversize | `notify_bad_payload` |
| Namespace not allowlisted | `notify_ns_drop` |

## Production path (not in this repo)

```
Postgres NOTIFY → edgehost LISTEN → state put → WS STATE_CHANGED → this consumer
```

Reconnect/backoff and multi-instance LISTEN are edgehost responsibilities
(P1.12). The demo WS path is a thin client only.

## Related

- [ADR-023](../decisions/023-dynamic-updates-host-notify.md)  
- [weather-package.md](../formats/weather-package.md) — static weather paint  
