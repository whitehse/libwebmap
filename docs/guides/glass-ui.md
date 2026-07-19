# Glass UI design language (host)

**P4.8 / ADR-021.** Host-only visual system for the WebGPU demo and future
SPA chrome. The C library does not own CSS, Canvas2D lens paint, or WGSL
material styles (ADR-014).

| Asset | Role |
|-------|------|
| [demo/display/glass_ui.css](../../demo/display/glass_ui.css) | CSS custom properties + panel/button/HUD classes |
| [demo/display/glass_tokens.js](../../demo/display/glass_tokens.js) | Same palette for Canvas2D / JS |
| [demo/display/fiber_style.js](../../demo/display/fiber_style.js) | Re-exports `MAG_*` from `GLASS_LENS` |
| [ADR-021](../decisions/021-glass-ui-design-language.md) | Decision record |
| [demo/display/glass_lens_gpu.js](../../demo/display/glass_lens_gpu.js) | P4.12 optional SDF lens (`?glass_gpu=1`) |
| [ADR-027](../decisions/027-webgpu-glass-lens.md) | GPU lens chrome experiment |

## Goals

| In scope | Out of scope |
|----------|--------------|
| Shared tokens for sidebar, floats, mem HUD, weather controls | Full design-system components library |
| Magnifier “glass” rim/fill colors matching CSS | Full schematic in WGSL (still Canvas) |
| Status colors aligned with `webmap_status_rgba` | Map basemap paint (Shortbread / VersaTiles) |
| `prefers-reduced-transparency` fallback | Light theme (dark-only v1) |

## Token groups

### Surfaces

| Token | Value | Use |
|-------|-------|-----|
| `--glass-bg-deep` | `#0b1220` | Page body |
| `--glass-bg-map` | `#0e1626` | Map canvas clear under WebGPU |
| `--glass-bg-header` | `#121a2b` | Top bar |
| `--glass-bg-panel` | `rgba(16,24,42,0.88)` | Floating HUD (path list) + blur |
| `--glass-bg-panel-solid` | `#10182a` | Sidebar (opaque for readability) |
| `--glass-bg-elevated-solid` | `#1a2740` | Buttons, list rows |
| `--glass-bg-inset` | `#0c1424` | Memory HUD well |
| `--glass-bg-lens` | `rgba(12,16,24,0.94)` | Magnifier fill (`MAG_BG`) |

### Rims / borders

| Token | Value | Use |
|-------|-------|-----|
| `--glass-rim` | `rgba(160,200,255,0.55)` | Magnifier outer rim (`MAG_RIM`) |
| `--glass-rim-inner` | `rgba(255,255,255,0.12)` | Inner rim highlight |
| `--glass-rim-tick` | `rgba(255,255,255,0.35)` | North tick on lens |
| `--glass-border` | `#2a3d5c` | Panel edges |
| `--glass-border-strong` | `#334a6d` | Controls |
| `--glass-blur` | `14px` | `backdrop-filter` on floats |

### Text

| Token | Use |
|-------|-----|
| `--glass-text` | Primary body |
| `--glass-text-secondary` | Header subtitle, log |
| `--glass-text-muted` | Footnotes |
| `--glass-text-accent` | Section titles |
| `--glass-text-code` | `<code>` / mono values |
| `--glass-text-lens` | Magnifier labels (`MAG_TEXT`) |

### Status (ops colors)

Match `webmap_status_rgba` / weather package mapping:

| Status | CSS | Packed `0xAABBGGRR` |
|--------|-----|---------------------|
| ok | `#2ecc71` | `0xFF2ECC71` |
| degraded | `#f1c40f` | `0xFFF1C40F` |
| down | `#e74c3c` | `0xFFE74C3C` |
| maint | `#3498db` | `0xFF3498DB` |
| unknown | `#95a5a6` | `0xFF95A5A6` |

Classes: `.ok` / `.warn` / `.err`, or `.glass-status-ok`, …

### Fiber / path accents

| Token | Role |
|-------|------|
| `--glass-accent` | Selected path id / gold highlight |
| `--glass-source` | Light / source hop |
| `--glass-through` | Tap through-fiber (IN→PT) |
| `--glass-mainline` / `--glass-fuse` / `--glass-tap` / `--glass-drop` | Schematic |

## CSS classes (quick)

| Class | Element |
|-------|---------|
| `glass-app` | `body` |
| `glass-header` | Top bar |
| `glass-shell` (+ `sidebar-collapsed`) | `#wrap` grid |
| `glass-map` | Map column |
| `glass-sidebar` / `-toggle` / `-body` | Info rail |
| `glass-float` / `glass-float--bottom-left` | Path list overlay |
| `glass-hud` | Memory counters |
| `glass-control-row` | Weather opacity row |
| `glass-panel` / `glass-btn` | Reusable chrome |
| `glass-log` | Scrollable log |

## Canvas2D

```js
import { GLASS_LENS, GLASS_STATUS } from "./glass_tokens.js";
// or historical aliases:
import { MAG_BG, MAG_RIM } from "./fiber_style.js";
```

Do **not** invent a second blue rim for new host chrome; extend
`glass_tokens.js` + `glass_ui.css` together and bump `GLASS_TOKENS_VERSION`
when breaking.

## WGSL note

Basemap/fiber pipelines keep packed vertex colors. Glass UI does not require
WGSL changes for P4.8.

### P4.12 — optional WebGPU glass lens (`?glass_gpu=1`)

`demo/display/glass_lens_gpu.js` draws an SDF disc (shadow, fill, dual rim,
north tick, soft specular) on the **map** WebGPU canvas using `GLASS_LENS`
token colors. Schematic content stays Canvas2D.

```
# default: Canvas chrome (unchanged)
python3 -m http.server -d build/demo 8765

# experiment: GPU lens chrome under the magnifier schematic
# open http://127.0.0.1:8765/?glass_gpu=1  and click a tap/splice
```

Status bar shows **`glass:gpu`** when the flag is on. See
[ADR-027](../decisions/027-webgpu-glass-lens.md).

## Accessibility

- Focus rings use `--glass-rim`.
- `@media (prefers-reduced-transparency: reduce)` disables blur and uses solid
  panel backgrounds.

## Related

- [ADR-014](../decisions/014-plumbing-vs-host-renderer.md) — host owns chrome  
- [ADR-016](../decisions/016-fiber-hover-magnifier.md) — glass lens interaction  
- [ADR-022](../decisions/022-weather-package-host-paint.md) — status colors on map  
