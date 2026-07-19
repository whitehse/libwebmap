/**
 * Fiber map display policy only — widths, radii, min-zooms, draw order.
 * Feature attributes (TIA colors, port counts, cable size) come from data.
 * Magnifier chrome colors come from glass_tokens.js (P4.8 / ADR-021).
 */

import { GLASS_LENS } from "./glass_tokens.js";

/** Linear interpolate style stops { zoom: value }. */
export function zoomStops(stops, zoom) {
  const zs = Object.keys(stops)
    .map(Number)
    .sort((a, b) => a - b);
  if (!zs.length) return 0;
  if (zoom <= zs[0]) return stops[zs[0]];
  if (zoom >= zs[zs.length - 1]) return stops[zs[zs.length - 1]];
  for (let i = 0; i < zs.length - 1; i++) {
    const z0 = zs[i];
    const z1 = zs[i + 1];
    if (zoom >= z0 && zoom <= z1) {
      const t = (zoom - z0) / (z1 - z0);
      return stops[z0] + (stops[z1] - stops[z0]) * t;
    }
  }
  return stops[zs[zs.length - 1]];
}

/** Min map zoom to show each feature class (display gate). */
export function fiberMinZoom(kind) {
  if (kind === "tap") return 13;
  if (kind === "splice") return 13;
  if (kind === "drop") return 12;
  if (kind === "cable") return 10;
  return 10;
}

/** Full line width in CSS px. */
export function styleLineWidthPx(kind, zoom) {
  if (kind === "drop") {
    return zoomStops({ 12: 1.8, 14: 2.6, 16: 3.5, 18: 4.5 }, zoom);
  }
  if (kind === "cable") {
    return zoomStops({ 10: 1.2, 12: 2, 14: 3, 16: 4.5, 18: 6 }, zoom);
  }
  return zoomStops({ 12: 1.5, 15: 2.5 }, zoom);
}

/**
 * Tap circle radius in CSS px — progressive growth with zoom.
 * Small when taps first appear; much larger at high zoom for readability.
 * (Display only; not encoded in feature data.)
 */
export function styleTapRadiusPx(zoom) {
  return zoomStops(
    {
      13: 5,
      14: 7,
      15: 10,
      16: 14,
      17: 20,
      18: 28,
    },
    zoom
  );
}

/**
 * Non-tap splicepoint hexagon radius (center → vertex) in CSS px.
 * Slightly smaller than taps so port circles remain primary.
 */
export function styleSpliceRadiusPx(zoom) {
  return zoomStops(
    {
      13: 4,
      14: 5.5,
      15: 8,
      16: 11,
      17: 16,
      18: 22,
    },
    zoom
  );
}

/** Default fill/stroke for splice hexagons (enclosure symbol). */
export const SPLICE_FILL = "rgba(30, 42, 68, 0.92)";
export const SPLICE_STROKE = "#7eb6ff";

/** Painter order (higher = later / on top). */
export function styleOrder(kind) {
  if (kind === "cable") return 90;
  if (kind === "drop") return 92;
  if (kind === "splice") return 94;
  if (kind === "tap") return 95;
  return 90;
}

export const FIBER_TAP_ZMIN_DEFAULT = 13;
export const FIBER_SPLICE_ZMIN_DEFAULT = 13;

/** Path-trace highlight color (packed 0xAABBGGRR — amber). */
export const TRACE_HIGHLIGHT_RGBA = 0xff00c8ff;

/** Dim factor for non-selected fiber lines while a path is highlighted. */
export const FIBER_DIM_FACTOR = 0.25;

/** Max path candidates listed for one cable pick. */
export const TRACE_MAX_CANDIDATES = 32;

/** Max hops shown in the path list panel. */
export const TRACE_MAX_HOPS_UI = 256;

/** Build diagram URL from index entry or fallback naming. */
export function diagramUrl(spGuid, diagramIndex, diagramsBase) {
  if (!spGuid) return null;
  const base = diagramsBase || "./splice_diagrams/";
  const name =
    (diagramIndex && diagramIndex[spGuid]) ||
    `sp_${spGuid}_${spGuid.slice(0, 8)}.html`;
  return base.replace(/\/?$/, "/") + name;
}

/* ── Hover magnifier (display policy) ──────────────────────────────── */

/** Dwell time before the magnifier opens (ms). */
export const HOVER_DELAY_MS = 420;

/** Extra screen-space pad when hit-testing lines (CSS px). */
export const LINE_HIT_PAD_PX = 4;

/** Lens radius in CSS px (content area inside the glass rim). */
export const MAGNIFIER_RADIUS_PX = 168;

/** Offset of lens center from the feature (CSS px). */
export const MAGNIFIER_OFFSET_PX = 40;

/**
 * Base pan range at zoom=1 when the pointer sits at the lens rim
 * (CSS px in schematic space). Scales with in-glass zoom.
 */
export const MAGNIFIER_PAN_RANGE_PX = 110;

/** Schematic content scale at zoom=1 (larger world than the glass). */
export const MAGNIFIER_WORLD_SCALE = 1.35;

/**
 * In-glass zoom limits (wheel while pointer is in the magnifier).
 * Min is low enough that large multi-cable / many-fiber SPs (144–288f)
 * fit entirely in the glass; max still allows strand-level inspection.
 */
export const MAGNIFIER_ZOOM_MIN = 0.16;
export const MAGNIFIER_ZOOM_MAX = 5.5;

/**
 * Max fibers drawn per cable rail in the magnifier schematic.
 * Sized for common plant cables (12…288f). Spacing densifies automatically.
 */
export const SCHEMATIC_MAX_FIBERS = 288;

/** TIA-598 fiber / tube color order (1-based fiber number → index 0). */
export const TIA_NAMES = [
  "Blue",
  "Orange",
  "Green",
  "Brown",
  "Slate",
  "White",
  "Red",
  "Black",
  "Yellow",
  "Violet",
  "Rose",
  "Aqua",
];

export const TIA_HEX = [
  "#1e5aa8",
  "#e67e22",
  "#27ae60",
  "#8b4513",
  "#708090",
  "#e8e8e8",
  "#c0392b",
  "#2c2c2c",
  "#f1c40f",
  "#8e44ad",
  "#e91e8c",
  "#5dade2",
];

/** 1-based fiber number → TIA hex. */
export function tiaFiberColor(fiberNum) {
  const i = Math.max(0, ((fiberNum || 1) - 1) % 12);
  return TIA_HEX[i];
}

/** 1-based fiber number → TIA name. */
export function tiaFiberName(fiberNum) {
  const i = Math.max(0, ((fiberNum || 1) - 1) % 12);
  return TIA_NAMES[i];
}

/** True when TIA chip needs a dark border for contrast (White / Yellow). */
export function tiaFiberIsLight(fiberNum) {
  const i = Math.max(0, ((fiberNum || 1) - 1) % 12);
  return i === 5 || i === 8;
}

/* Magnifier accent colors — from glass_tokens.js (single palette). */
export const MAG_BG = GLASS_LENS.bg;
export const MAG_RIM = GLASS_LENS.rim;
export const MAG_RIM_INNER = GLASS_LENS.rimInner;
export const MAG_TEXT = GLASS_LENS.text;
export const MAG_MUTED = GLASS_LENS.muted;
export const MAG_TAP = GLASS_LENS.tap;
export const MAG_DROP = GLASS_LENS.drop;
export const MAG_DROP_FILL = GLASS_LENS.dropFill;
export const MAG_SPLICE = GLASS_LENS.splice;
export const MAG_MAINLINE = GLASS_LENS.mainline;
export const MAG_FUSE = GLASS_LENS.fuse;
export const MAG_HINT = GLASS_LENS.hint;
/** Through-tap (Input → Pass Through) path in magnifier. */
export const MAG_THROUGH = GLASS_LENS.through;
export const MAG_THROUGH_GLOW = GLASS_LENS.throughGlow;
/** Light / source accent on path budget. */
export const MAG_SOURCE = GLASS_LENS.source;
/** Path loss severity colors. */
export const LOSS_OK = "#3dcc7a";
export const LOSS_WARN = "#e6b84d";
export const LOSS_CRIT = "#e85d5d";
