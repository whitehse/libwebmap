# ADR-019: Memory budgets from measurement (P4.0 / P4.1)

## Status

Accepted (P4.0 measurement harness; budgets feed P4.2–P4.13)

## Date

2026-07-18

## Context

Program Track 4 required **measurement before** free-list implementation and
WASM default-on. Operators reported ~85 MiB → ~500 MiB browser memory after fiber
features; that figure was an unverified hypothesis until JS heap, GPU buffers,
and WASM linear memory were attributed separately.

Design PR plan: **P4.0** harness + attribution doc; **P4.1** ADRs with
**budgets as data** (not inventing caps up front).

## Decision

1. **Measure first.** Demo exposes `demo/display/mem_stats.js` and a sidebar HUD
   (hide with `?mem=0`). Capture protocol lives in
   [memory-attribution.md](../guides/memory-attribution.md).
2. **Budgets are derived from snapshots**, not fixed marketing numbers:
   | Cap | Source / use |
   |-----|----------------|
   | `max_tiles` default **256** | P4.2 host + C LRU; `?max_tiles=` override |
   | WASM heap watermark **75%** | P4.3 / ADR-025 safety reload |
   | Accounted Σ | HUD lower bound (JS + GPU + WASM), not process RSS |
3. **Layers stay separate:** JS heap ≠ GPU buffer bytes ≠ WASM pages ≠ OS RSS.
   Never sum them into a single “memory” KPI without labeling.
4. **Primary reclaim path** after measurement: freestanding free-list (ADR-025);
   module reload on watermark is the safety net. Host-imported malloc is not
   primary (program Key Decision).
5. **Default-on WASM** only after gate criteria in
   [wasm-default-on-gate.md](../guides/wasm-default-on-gate.md) (P4.13).

## Consequences

- ADR-024/025/026 implement contract, free-list, and default policy using these
  measurement-backed caps.
- Further budget changes require a new snapshot protocol row, not silent code
  constants.

## Alternatives considered

| Option | Why not |
|--------|---------|
| Invent 100 MiB hard gate before measure | Design forbids guessing |
| Process RSS only | Cannot attribute JS vs GPU vs WASM |
| Unlimited tiles until OOM | Regression mode (`?max_tiles=0` only for debug) |
