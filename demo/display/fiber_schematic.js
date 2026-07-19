/**
 * Canvas2D schematics for the fiber meet-point magnifier.
 *
 * Clean exploratory meet-point view (office / tech — not splicer sheets):
 *  - Cable / drop approaches use exact geographic bearings (0=N, 90=E)
 *  - Strand dots on each span; fuse pairs drawn as clean midlines
 *  - Highlight a strand and its paired peer on the other span
 *  - Host pans + zooms the schematic world under the glass
 */

import {
  MAG_TEXT,
  MAG_MUTED,
  MAG_TAP,
  MAG_DROP,
  MAG_DROP_FILL,
  MAG_SPLICE,
  MAG_MAINLINE,
  MAG_FUSE,
  MAG_HINT,
  MAG_THROUGH,
  MAG_THROUGH_GLOW,
  MAG_SOURCE,
  SCHEMATIC_MAX_FIBERS,
  MAGNIFIER_WORLD_SCALE,
  MAGNIFIER_ZOOM_MIN,
  MAGNIFIER_ZOOM_MAX,
  tiaFiberColor,
  tiaFiberIsLight,
} from "./fiber_style.js";
import {
  tapLightTopology,
  fmtLossDb,
} from "./optical_budget.js";

function shortGuid(g) {
  if (!g) return "—";
  return String(g).slice(0, 8);
}

export function fmtLoss(db) {
  if (db == null || db === "") return null;
  const n = Number(db);
  if (Number.isNaN(n)) return null;
  if (n === 0) return "0 dB";
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return `${s} dB`;
}

function roundedRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export function drawFiberChip(ctx, cx, cy, fiberNum, r = 5) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = tiaFiberColor(fiberNum);
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = tiaFiberIsLight(fiberNum)
    ? "rgba(0,0,0,0.45)"
    : "rgba(255,255,255,0.35)";
  ctx.stroke();
}

export function drawLensChrome(ctx, cx, cy, r, title, footer) {
  const top = cy - r + 12;
  ctx.fillStyle = MAG_TEXT;
  ctx.font = `600 ${Math.max(10, r * 0.1)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, cx, top, r * 1.75);

  let bodyBot = cy + r - 10;
  if (footer) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `${Math.max(7, r * 0.07)}px system-ui, sans-serif`;
    ctx.fillText(footer, cx, cy + r - 10, r * 1.8);
    bodyBot = cy + r - 20;
  }
  return { bodyTop: top + 10, bodyBot };
}

/* ── Direction helpers ─────────────────────────────────────────────── */

/** Normalize degrees to [0, 360). */
export function normalizeDeg(deg) {
  let d = Number(deg);
  if (!Number.isFinite(d)) return 0;
  d = d % 360;
  if (d < 0) d += 360;
  return d;
}

/**
 * Snap degrees to nearest 45° (0=N … 315=NW).
 * Kept for tests / callers that want a compass bin; layout no longer snaps.
 */
export function snapDeg45(deg) {
  const d = normalizeDeg(deg);
  return (Math.round(d / 45) * 45) % 360;
}

/** Angular distance in [0, 180]. */
export function angDistDeg(a, b) {
  let d = Math.abs(normalizeDeg(a) - normalizeDeg(b)) % 360;
  if (d > 180) d = 360 - d;
  return d;
}

/** 0=N top → unit vector in canvas space (+x right, +y down). */
export function approachUnit(deg) {
  const a = (normalizeDeg(deg) * Math.PI) / 180;
  return { x: Math.sin(a), y: -Math.cos(a) };
}

export function compassFromDeg(deg) {
  if (deg == null || Number.isNaN(Number(deg))) return null;
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const i = Math.round(normalizeDeg(deg) / 45) % 8;
  return labels[i];
}

/**
 * Human label for an approach: compass name when within 3° of a 45° spoke,
 * otherwise the exact bearing (e.g. "32°").
 */
export function approachLabel(deg) {
  if (deg == null || Number.isNaN(Number(deg))) return null;
  const d = normalizeDeg(deg);
  const snapped = snapDeg45(d);
  if (angDistDeg(d, snapped) < 3) return compassFromDeg(snapped);
  return `${Math.round(d)}°`;
}

/**
 * Place cables on the approach ring at their true geographic bearings.
 * Only near-duplicates (< ~2°) are nudged by 1° so chips do not stack.
 * @param {Array} cables
 * @param {number} cx
 * @param {number} cy
 * @param {number} radius
 */
export function layoutCablesByApproach(cables, cx, cy, radius) {
  const list = (cables || []).slice();
  const out = new Map();
  if (!list.length) return out;

  /** @type {number[]} */
  const used = [];
  const minSep = 2; // degrees — only break exact/near stacks

  list.forEach((c, i) => {
    let deg =
      c.approach_deg != null && !Number.isNaN(Number(c.approach_deg))
        ? normalizeDeg(c.approach_deg)
        : normalizeDeg((i * 360) / Math.max(list.length, 1));

    for (let step = 0; step < 360; step++) {
      const collision = used.some((u) => angDistDeg(u, deg) < minSep);
      if (!collision) {
        used.push(deg);
        break;
      }
      deg = normalizeDeg(deg + 1);
    }

    const u = approachUnit(deg);
    out.set(c.guid, {
      guid: c.guid,
      size: c.size,
      is_drop: !!c.is_drop,
      deg,
      label: c.approach || approachLabel(deg),
      ux: u.x,
      uy: u.y,
      // Hub sits on the ring; fiber column is further out
      x: cx + u.x * radius,
      y: cy + u.y * radius,
    });
  });
  return out;
}

/** @typedef {{ kind:string, x:number, y:number, r:number, cable_guid?:string, fiber?:number, pair_cable?:string, pair_fiber?:number, role?:string, label?:string }} MagHit */

export function hitTestSchematic(hits, x, y) {
  if (!hits || !hits.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const h of hits) {
    const d = Math.hypot(x - h.x, y - h.y);
    if (d <= (h.r || 8) && d < bestD) {
      bestD = d;
      best = h;
    }
  }
  return best;
}

/**
 * Build undirected fuse endpoint pairs for hover highlighting.
 * @returns {Array<{a:{cable:string,fiber:number}, b:{cable:string,fiber:number}, loss?:number}>}
 */
export function fusePairsFromLinks(links) {
  const out = [];
  for (const l of links || []) {
    if (l.role !== "fuse" || !l.a?.cable || !l.b?.cable) continue;
    if (!(l.a.fiber > 0) || !(l.b.fiber > 0)) continue;
    out.push({
      a: { cable: l.a.cable, fiber: l.a.fiber },
      b: { cable: l.b.cable, fiber: l.b.fiber },
      loss: l.loss_db,
    });
  }
  return out;
}

/**
 * Count fibers that would be drawn per cable (mirrors drawGeoMeetSchematic).
 */
function fiberCountsForDetail(detail) {
  const links = detail?.links || [];
  const cables = detail?.cables || [];
  const counts = [];
  for (const c of cables) {
    const s = new Set();
    for (const l of links) {
      if (l.a?.cable === c.guid && l.a.fiber > 0) s.add(l.a.fiber);
      if (l.b?.cable === c.guid && l.b.fiber > 0) s.add(l.b.fiber);
    }
    counts.push(Math.min(s.size || 0, SCHEMATIC_MAX_FIBERS));
  }
  return counts;
}

/**
 * Adaptive strand column geometry so 12…288f rails stay drawable.
 * Dense plant cables use tighter pitch; zoom-in restores individual chips.
 *
 * @param {number} fiberCount
 * @returns {{ count:number, slot:number, chipR:number, colHalf:number }}
 */
export function strandLayoutMetrics(fiberCount) {
  const count = Math.min(
    Math.max(0, Math.floor(Number(fiberCount) || 0)),
    SCHEMATIC_MAX_FIBERS
  );
  let slot;
  let chipR;
  if (count <= 24) {
    slot = 12;
    chipR = 5;
  } else if (count <= 48) {
    slot = 8;
    chipR = 4;
  } else if (count <= 72) {
    slot = 6;
    chipR = 3.4;
  } else if (count <= 96) {
    slot = 5;
    chipR = 3;
  } else if (count <= 144) {
    slot = 3.8;
    chipR = 2.5;
  } else if (count <= 216) {
    slot = 3.1;
    chipR = 2.2;
  } else {
    // 217…288
    slot = 2.55;
    chipR = 1.9;
  }
  const colHalf =
    count > 0 ? ((count - 1) / 2) * slot + chipR + 2 : chipR + 2;
  return { count, slot, chipR, colHalf };
}

/**
 * Zoom that fits the whole meet-point (all cable rails + strand columns)
 * inside the glass. Uses the same layout metrics as drawGeoMeetSchematic.
 *
 * Screen radius of content ≈ 0.58·bodyR + fixed_padding · worldScale
 * (fiber columns and labels are fixed in local units, so they shrink when
 * worldScale shrinks — i.e. when zooming out).
 *
 * @param {object|null} detail
 * @param {number} bodyR usable body radius inside chrome (CSS px)
 * @returns {number} zoom in [MAGNIFIER_ZOOM_MIN, 1.0] (never auto-zooms in past 1)
 */
export function fitZoomForDetail(detail, bodyR) {
  if (!detail || !(bodyR > 8)) return 1;
  const counts = fiberCountsForDetail(detail);
  const nCab = (detail.cables || []).length;
  const maxFib = counts.length ? Math.max(0, ...counts) : 0;
  const metrics = strandLayoutMetrics(maxFib);
  const outPull = 6;
  const labelOut = 22;
  // Radial extent beyond the scaled ring (labels + outward chip pull)
  const radialExtra = labelOut + outPull + metrics.chipR + 2;
  // Fixed local padding that must fit after scale (not proportional to localR)
  const fixedLocal = Math.hypot(radialExtra, metrics.colHalf);
  // Tighter margin when packing very large fiber counts
  const margin =
    maxFib >= 96 ? 0.72 : nCab >= 4 || maxFib >= 24 ? 0.78 : 0.88;
  // Need: 0.58 * bodyR + fixedLocal * (WORLD_SCALE * zoom) <= margin * bodyR
  // → zoom <= (margin - 0.58) * bodyR / (fixedLocal * WORLD_SCALE)
  const budget = (margin - 0.58) * bodyR;
  if (budget <= 1 || fixedLocal < 1) return 1;
  const maxWorld = budget / fixedLocal;
  let z = maxWorld / MAGNIFIER_WORLD_SCALE;
  // Prefer showing the whole SP on open; clamp to limits (cap at 1 so we only auto-zoom-out)
  z = Math.min(1, Math.max(MAGNIFIER_ZOOM_MIN, z));
  return Math.round(z * 100) / 100;
}

/**
 * Endpoints that should light up given a hover fiber (self + all fuse peers).
 * @returns {Array<{cable:string,fiber:number}>}
 */
export function pairEndpoints(fusePairs, cableGuid, fiber) {
  if (!cableGuid || !(fiber > 0)) return [];
  const eps = [{ cable: cableGuid, fiber }];
  const seen = new Set([`${cableGuid}|${fiber}`]);
  for (const p of fusePairs) {
    let peer = null;
    if (p.a.cable === cableGuid && p.a.fiber === fiber) peer = p.b;
    else if (p.b.cable === cableGuid && p.b.fiber === fiber) peer = p.a;
    if (!peer) continue;
    const k = `${peer.cable}|${peer.fiber}`;
    if (seen.has(k)) continue;
    seen.add(k);
    eps.push(peer);
  }
  return eps;
}

function endpointKey(cable, fiber) {
  return `${cable}|${fiber}`;
}

function isEndpointFocused(focus, cable, fiber) {
  if (!focus) return false;
  if (focus.endpoints) {
    return focus.endpoints.some(
      (e) => e.cable === cable && e.fiber === fiber
    );
  }
  return focus.cable_guid === cable && focus.fiber === fiber;
}

function anyEndpointFocus(focus) {
  return !!(
    focus &&
    (focus.fiber != null || (focus.endpoints && focus.endpoints.length))
  );
}

/* ── Fallbacks ─────────────────────────────────────────────────────── */

export function drawTapEnlarged(ctx, cx, cy, rBody, hit) {
  const r = rBody * 0.28;
  ctx.beginPath();
  ctx.arc(cx, cy - 4, r, 0, Math.PI * 2);
  const strand = hit.strand != null ? hit.strand : 0xff4280e0;
  const tube = hit.tube != null ? hit.tube : 0xff808080;
  ctx.fillStyle = rgbaToCss(strand);
  ctx.fill();
  ctx.lineWidth = Math.max(2, r * 0.18);
  ctx.strokeStyle = rgbaToCss(tube);
  ctx.stroke();
  const ports = hit.ports || 0;
  if (ports > 0) {
    ctx.fillStyle = "#fff";
    ctx.font = `700 ${Math.max(12, r * 0.9)}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = 3;
    ctx.strokeText(String(ports), cx, cy - 4);
    ctx.fillText(String(ports), cx, cy - 4);
  }
  ctx.fillStyle = MAG_MUTED;
  ctx.font = `${Math.max(9, rBody * 0.1)}px system-ui, sans-serif`;
  ctx.fillText(ports > 0 ? `${ports}-port tap` : "Tap", cx, cy + r + 16, rBody * 1.6);
}

export function drawSpliceEnlarged(ctx, cx, cy, rBody, hit) {
  const r = rBody * 0.26;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;
    const x = cx + r * Math.cos(a);
    const y = cy - 4 + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fillStyle = "rgba(30, 42, 68, 0.95)";
  ctx.fill();
  ctx.strokeStyle = MAG_SPLICE;
  ctx.lineWidth = Math.max(2, r * 0.2);
  ctx.stroke();
  ctx.fillStyle = MAG_MUTED;
  ctx.font = `${Math.max(9, rBody * 0.1)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText("Splice enclosure", cx, cy + r + 16, rBody * 1.6);
}

export function drawLineCallout(ctx, cx, cy, rBody, hit) {
  const isDrop = hit.kind === "drop";
  const w = rBody * 1.1;
  ctx.save();
  ctx.lineWidth = isDrop ? 4 : 5;
  ctx.strokeStyle = isDrop ? MAG_DROP : MAG_MAINLINE;
  if (isDrop) ctx.setLineDash([6, 4]);
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(cx - w * 0.45, cy - 6);
  ctx.lineTo(cx + w * 0.45, cy - 6);
  ctx.stroke();
  ctx.restore();
  const size = hit.cable_size || 0;
  ctx.fillStyle = MAG_TEXT;
  ctx.font = `600 ${Math.max(11, rBody * 0.12)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.fillText(
    isDrop
      ? size
        ? `Drop · ${size}f`
        : "Drop fiber"
      : size
        ? `Cable · ${size}f`
        : "Mainline cable",
    cx,
    cy + 18,
    rBody * 1.7
  );
}

/* ── Clean meet-point schematic ────────────────────────────────────── */

function fibersForCable(guid, links) {
  const s = new Set();
  for (const l of links || []) {
    if (l.a?.cable === guid && l.a.fiber > 0) s.add(l.a.fiber);
    if (l.b?.cable === guid && l.b.fiber > 0) s.add(l.b.fiber);
  }
  return [...s].sort((a, b) => a - b);
}

/**
 * Perpendicular axis for strand order along a cable rail.
 *
 * Approach vector alone would flip the cross product on opposite sides
 * (E uses +Y, W uses −Y), so matching f1…fn would read top-to-bottom on
 * one span and bottom-to-top on the other. Snap the cross axis so:
 *  - Vertical columns (E/W and nearby diagonals): fiber # increases **down**
 *  - Horizontal columns (N/S and nearby diagonals): fiber # increases **right**
 *
 * @param {number} ux approach unit x
 * @param {number} uy approach unit y
 * @returns {{x:number,y:number}}
 */
export function strandCrossAxis(ux, uy) {
  // Left-handed perpendicular to approach (into the rail column)
  let px = -uy;
  let py = ux;
  const len = Math.hypot(px, py) || 1;
  px /= len;
  py /= len;

  if (Math.abs(py) >= Math.abs(px) - 1e-9) {
    // Column is more vertical → increasing fibers go south (+screen Y)
    if (py < 0) {
      px = -px;
      py = -py;
    }
  } else {
    // Column is more horizontal → increasing fibers go east (+screen X)
    if (px < 0) {
      px = -px;
      py = -py;
    }
  }
  return { x: px, y: py };
}

/** Small chevron along a segment showing light / flow direction. */
function drawLightArrow(ctx, x0, y0, x1, y1, color) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy) || 1;
  if (len < 12) return;
  const t = 0.62;
  const ax = x0 + dx * t;
  const ay = y0 + dy * t;
  const ux = dx / len;
  const uy = dy / len;
  const s = 5;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(ax + ux * s, ay + uy * s);
  ctx.lineTo(ax - uy * s * 0.55, ay + ux * s * 0.55);
  ctx.lineTo(ax + uy * s * 0.55, ay - ux * s * 0.55);
  ctx.closePath();
  ctx.fill();
}

/**
 * Orthogonal-ish path between two points (H-V-H or V-H-V via midpoint).
 * Keeps a clean 90° feel for fusion bridges.
 */
function drawOrthoBridge(ctx, x0, y0, x1, y1) {
  const mx = (x0 + x1) / 2;
  const my = (y0 + y1) / 2;
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  if (dx < 2 || dy < 2) {
    // Nearly axis-aligned already
    ctx.lineTo(x1, y1);
  } else if (dx >= dy) {
    // Horizontal-dominant: mid vertical step
    ctx.lineTo(mx, y0);
    ctx.lineTo(mx, y1);
    ctx.lineTo(x1, y1);
  } else {
    ctx.lineTo(x0, my);
    ctx.lineTo(x1, my);
    ctx.lineTo(x1, y1);
  }
  ctx.stroke();
  return { mx, my };
}

/**
 * Build layout Map + fiberPos from a decoded WSCH blob (P4.10/P4.11).
 * Coordinates are relative to layout origin (0,0); we offset by (cx,cy).
 *
 * @param {object} precomputed decodeSchematicLayout result
 * @param {number} cx
 * @param {number} cy
 * @returns {{
 *   layout: Map<string, object>,
 *   fiberPos: Map<string, object>,
 *   chipR: number,
 *   railR: number
 * }|null}
 */
export function mapsFromSchematicLayout(precomputed, cx, cy) {
  if (!precomputed?.ok || !precomputed.cables?.length) return null;
  const ox = (precomputed.header?.cx ?? 0) - cx;
  const oy = (precomputed.header?.cy ?? 0) - cy;
  // layout engine used (0,0) when we pass 0,0 — chips are already at origin.
  // If header cx/cy match our cx/cy, no shift. Prefer translating so hubs
  // align with requested center: positions were computed at header origin.
  const dx = cx - (precomputed.header?.cx ?? 0);
  const dy = cy - (precomputed.header?.cy ?? 0);
  void ox;
  void oy;

  /** @type {Map<string, object>} */
  const layout = new Map();
  for (const c of precomputed.cables) {
    layout.set(c.guid, {
      guid: c.guid,
      size: c.size,
      is_drop: !!c.is_drop,
      deg: c.approach_deg,
      label: approachLabel(c.approach_deg),
      ux: c.ux,
      uy: c.uy,
      x: c.x + dx,
      y: c.y + dy,
    });
  }
  /** @type {Map<string, {x:number,y:number,pos:object,fiber:number,chipR:number}>} */
  const fiberPos = new Map();
  let chipR = 5;
  for (const f of precomputed.fibers || []) {
    const cab = precomputed.cables[f.cable_index];
    if (!cab) continue;
    const pos = layout.get(cab.guid);
    if (!pos) continue;
    chipR = f.chip_r || chipR;
    fiberPos.set(endpointKey(cab.guid, f.fiber_num), {
      x: f.x + dx,
      y: f.y + dy,
      pos,
      fiber: f.fiber_num,
      chipR: f.chip_r || chipR,
    });
  }
  const railR =
    (precomputed.header?.radius != null
      ? precomputed.header.radius * 0.58
      : 58) || 58;
  return { layout, fiberPos, chipR, railR };
}

/**
 * @param {CanvasRenderingContext2D} ctx
 * @param {number} cx
 * @param {number} cy
 * @param {number} r
 * @param {object} detail
 * @param {object|null} focus
 * @param {{ precomputed?: object|null }} [opts]
 * @returns {MagHit[]}
 */
export function drawGeoMeetSchematic(ctx, cx, cy, r, detail, focus, opts = {}) {
  /** @type {MagHit[]} */
  const hits = [];
  const cables = detail.cables || [];
  const links = detail.links || [];
  const tap = detail.tap;
  const isTap = !!(detail.kind === "tap" || tap);
  const fusePairs = fusePairsFromLinks(links);
  const equipLinks = links.filter(
    (l) =>
      l.role === "ingress" ||
      l.role === "egress" ||
      l.role === "drop" ||
      l.role === "equip"
  );

  const railR = r * 0.58;
  /** @type {Map<string, object>} */
  let layout;
  /** @type {Map<string, {x:number,y:number,pos:object,fiber:number,chipR:number}>} */
  let fiberPos;
  let chipR = 5;

  const pre = mapsFromSchematicLayout(opts.precomputed, cx, cy);
  if (pre) {
    layout = pre.layout;
    fiberPos = pre.fiberPos;
    chipR = pre.chipR;
  } else {
    layout = layoutCablesByApproach(cables, cx, cy, railR);
    fiberPos = new Map();
    /** @type {Map<string, number[]>} */
    const fibersByCable = new Map();
    let maxFibOnRail = 0;
    for (const pos of layout.values()) {
      let fibers = fibersForCable(pos.guid, links);
      if (!fibers.length && equipLinks.length) {
        for (const l of equipLinks) {
          if (l.a?.cable === pos.guid && l.a.fiber > 0) fibers.push(l.a.fiber);
        }
        fibers = [...new Set(fibers)].sort((a, b) => a - b);
      }
      fibers = fibers.slice(0, SCHEMATIC_MAX_FIBERS);
      fibersByCable.set(pos.guid, fibers);
      if (fibers.length > maxFibOnRail) maxFibOnRail = fibers.length;
    }
    const railMetrics = strandLayoutMetrics(maxFibOnRail);
    const { slot } = railMetrics;
    chipR = railMetrics.chipR;

    for (const pos of layout.values()) {
      const fibers = fibersByCable.get(pos.guid) || [];
      const cross = strandCrossAxis(pos.ux, pos.uy);
      const outX = pos.x + pos.ux * 6;
      const outY = pos.y + pos.uy * 6;
      const n = fibers.length;
      fibers.forEach((fn, i) => {
        const t = n <= 1 ? 0 : i - (n - 1) / 2;
        const fx = outX + cross.x * t * slot;
        const fy = outY + cross.y * t * slot;
        fiberPos.set(endpointKey(pos.guid, fn), {
          x: fx,
          y: fy,
          pos,
          fiber: fn,
          chipR,
        });
      });
    }
  }

  // Subtle N marker only (minimal chrome)
  ctx.fillStyle = "rgba(255,255,255,0.22)";
  ctx.font = `700 8px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText("N", cx, cy - r * 0.9);

  const focused = anyEndpointFocus(focus);
  const tapTopo = isTap ? tapLightTopology(detail) : null;

  // Endpoints that are through-tap (IN/PT) — not ordinary fuse
  /** @type {Set<string>} */
  const throughKeys = new Set();
  if (tapTopo) {
    for (const t of tapTopo.through) {
      throughKeys.add(endpointKey(t.in.cable, t.in.fiber));
      throughKeys.add(endpointKey(t.out.cable, t.out.fiber));
    }
    for (const d of tapTopo.drops) {
      if (d.drop) throughKeys.add(endpointKey(d.drop.cable, d.drop.fiber));
      if (d.from) throughKeys.add(endpointKey(d.from.cable, d.from.fiber));
    }
  }

  // ── Fuse bridges (cable↔cable only; skip pure through-tap fibers) ─
  for (const p of fusePairs) {
    const ka = endpointKey(p.a.cable, p.a.fiber);
    const kb = endpointKey(p.b.cable, p.b.fiber);
    // If both ends are only the tap feed pair, still draw fuse for other fibers
    const pa = fiberPos.get(ka);
    const pb = fiberPos.get(kb);
    if (!pa || !pb) continue;

    const lit =
      isEndpointFocused(focus, p.a.cable, p.a.fiber) ||
      isEndpointFocused(focus, p.b.cable, p.b.fiber);
    const dim = focused && !lit;

    ctx.save();
    ctx.globalAlpha = dim ? 0.08 : lit ? 1 : 0.4;
    ctx.strokeStyle = lit ? "rgba(241, 196, 15, 0.95)" : "rgba(93, 173, 226, 0.5)";
    ctx.lineWidth = lit ? 2.4 : 1.25;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    const mid = drawOrthoBridge(ctx, pa.x, pa.y, pb.x, pb.y);

    if (lit || !focused) {
      ctx.fillStyle = lit ? "rgba(241, 196, 15, 0.95)" : MAG_FUSE;
      ctx.font = `700 ${lit ? 11 : 8}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("×", mid.mx, mid.my);
    }
    ctx.restore();
  }

  // ── Through-tap path (IN → enclosure → PT) — distinct from fuse × ─
  if (tapTopo && tapTopo.through.length) {
    for (const t of tapTopo.through) {
      const pin = fiberPos.get(endpointKey(t.in.cable, t.in.fiber));
      const pout = fiberPos.get(endpointKey(t.out.cable, t.out.fiber));
      if (!pin || !pout) continue;

      const lit =
        isEndpointFocused(focus, t.in.cable, t.in.fiber) ||
        isEndpointFocused(focus, t.out.cable, t.out.fiber) ||
        focus?.throughTap;
      const dim = focused && !lit;

      ctx.save();
      ctx.globalAlpha = dim ? 0.12 : 1;
      // Glow underlay
      ctx.strokeStyle = MAG_THROUGH_GLOW;
      ctx.lineWidth = lit ? 7 : 5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(pin.x, pin.y);
      ctx.lineTo(cx, cy);
      ctx.lineTo(pout.x, pout.y);
      ctx.stroke();

      // Main through path
      ctx.strokeStyle = lit ? "#ffc857" : MAG_THROUGH;
      ctx.lineWidth = lit ? 2.8 : 2.2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(pin.x, pin.y);
      ctx.lineTo(cx, cy);
      ctx.lineTo(pout.x, pout.y);
      ctx.stroke();

      // Light direction arrows: IN → center → PT
      drawLightArrow(ctx, pin.x, pin.y, cx, cy, lit ? "#ffc857" : MAG_THROUGH);
      drawLightArrow(ctx, cx, cy, pout.x, pout.y, lit ? "#ffc857" : MAG_THROUGH);

      // Labels
      ctx.fillStyle = lit ? "#ffe6a8" : MAG_THROUGH;
      ctx.font = `700 ${lit ? 9 : 8}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      const midInX = (pin.x + cx) / 2;
      const midInY = (pin.y + cy) / 2;
      ctx.fillText("IN", midInX, midInY - 4);
      const midOutX = (pout.x + cx) / 2;
      const midOutY = (pout.y + cy) / 2;
      ctx.textBaseline = "top";
      const ptLoss = fmtLossDb(t.pt_loss_db);
      ctx.fillText(
        ptLoss !== "—" ? `PT ${ptLoss}` : "PT",
        midOutX,
        midOutY + 3
      );

      // Source chevron near IN fiber
      ctx.fillStyle = MAG_SOURCE;
      ctx.font = `700 7px system-ui, sans-serif`;
      ctx.textBaseline = "bottom";
      ctx.fillText("◉ src", pin.x, pin.y - (pin.chipR || chipR) - 6);

      ctx.restore();

      hits.push({
        kind: "fiber",
        x: pin.x,
        y: pin.y,
        r: 10,
        cable_guid: t.in.cable,
        fiber: t.in.fiber,
        pair_cable: t.out.cable,
        pair_fiber: t.out.fiber,
        role: "through_in",
        label: `IN f${t.in.fiber} → PT`,
      });
      hits.push({
        kind: "fiber",
        x: pout.x,
        y: pout.y,
        r: 10,
        cable_guid: t.out.cable,
        fiber: t.out.fiber,
        pair_cable: t.in.cable,
        pair_fiber: t.in.fiber,
        role: "through_pt",
        label: `PT f${t.out.fiber}`,
      });
    }
  }

  // ── Drop legs from tap ───────────────────────────────────────────
  if (tapTopo && tapTopo.drops.length) {
    for (const d of tapTopo.drops) {
      if (!d.drop) continue;
      const pd = fiberPos.get(endpointKey(d.drop.cable, d.drop.fiber));
      // If drop fiber not in fuse list, place was from equip links — may be in fiberPos
      if (!pd) continue;
      const lit =
        isEndpointFocused(focus, d.drop.cable, d.drop.fiber) ||
        (d.from && isEndpointFocused(focus, d.from.cable, d.from.fiber));
      const dim = focused && !lit;
      ctx.save();
      ctx.globalAlpha = dim ? 0.12 : 0.95;
      ctx.strokeStyle = lit ? "#ff6b6b" : MAG_DROP;
      ctx.lineWidth = lit ? 2.4 : 1.8;
      ctx.setLineDash([5, 3]);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(pd.x, pd.y);
      ctx.stroke();
      ctx.setLineDash([]);
      drawLightArrow(ctx, cx, cy, pd.x, pd.y, lit ? "#ff6b6b" : MAG_DROP);
      ctx.fillStyle = lit ? "#ffb0b0" : MAG_DROP;
      ctx.font = `700 8px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const mx = (cx + pd.x) / 2;
      const my = (cy + pd.y) / 2;
      const dLoss = fmtLossDb(d.loss_db);
      ctx.fillText(
        d.drop_port != null ? `DROP ${d.drop_port} ${dLoss}` : `DROP ${dLoss}`,
        mx,
        my
      );
      ctx.restore();
    }
  }

  // ── Trunk stubs (approach only, no clutter) ──────────────────────
  for (const pos of layout.values()) {
    const color = pos.is_drop ? MAG_DROP : MAG_MAINLINE;
    ctx.strokeStyle = color;
    ctx.globalAlpha = focused ? 0.35 : 0.85;
    ctx.lineWidth = pos.is_drop ? 1.5 : 2.2;
    if (pos.is_drop) ctx.setLineDash([4, 3]);
    ctx.beginPath();
    // Orthogonal stub: from enclosure edge to hub
    const x0 = cx + pos.ux * 14;
    const y0 = cy + pos.uy * 14;
    const x1 = pos.x - pos.ux * 10;
    const y1 = pos.y - pos.uy * 10;
    // Keep stub radial (true approach unit vectors)
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // ── Enclosure ────────────────────────────────────────────────────
  const encR = isTap ? 22 : 14;
  if (isTap) {
    roundedRect(ctx, cx - encR, cy - encR * 0.72, encR * 2, encR * 1.44, 9);
    ctx.fillStyle = "rgba(58, 40, 16, 0.92)";
    ctx.fill();
    ctx.lineWidth = 1.8;
    ctx.strokeStyle = MAG_TAP;
    ctx.stroke();
    const name = tap?.name || (tap?.ports ? `${tap.ports}P` : "Tap");
    ctx.fillStyle = MAG_TAP;
    ctx.font = `700 11px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(name, cx, cy - 6, encR * 1.85);
    // Feed fiber that goes through the tap (clearer than fuse list alone)
    const feedF = tapTopo?.feed_fiber;
    const dropLoss = fmtLoss(tap?.loss_db);
    ctx.fillStyle = MAG_THROUGH;
    ctx.font = `700 8px system-ui, sans-serif`;
    if (feedF != null) {
      ctx.fillText(`thru f${feedF}`, cx, cy + 6, encR * 1.9);
    }
    if (dropLoss) {
      ctx.fillStyle = MAG_DROP;
      ctx.font = `600 7px system-ui, sans-serif`;
      ctx.fillText(`drop ${dropLoss}`, cx, cy + 15, encR * 1.9);
    }
    hits.push({
      kind: "equipment",
      x: cx,
      y: cy,
      r: encR + 4,
      role: "tap",
      label: name,
      throughTap: true,
    });
  } else {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      const x = cx + encR * Math.cos(a);
      const y = cy + encR * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fillStyle = "rgba(30, 42, 68, 0.92)";
    ctx.fill();
    ctx.strokeStyle = MAG_SPLICE;
    ctx.lineWidth = 1.6;
    ctx.stroke();
    hits.push({
      kind: "equipment",
      x: cx,
      y: cy,
      r: encR + 4,
      role: "splice",
      label: "Enclosure",
    });
  }

  // ── Cable labels (compact) + strand dots ─────────────────────────
  for (const pos of layout.values()) {
    const isDrop = pos.is_drop;
    const color = isDrop ? MAG_DROP : MAG_MAINLINE;
    const compass = pos.label || compassFromDeg(pos.deg) || "";

    // Small label outside the ring — one line only
    const lx = pos.x + pos.ux * 20;
    const ly = pos.y + pos.uy * 20;
    ctx.globalAlpha = focused ? 0.4 : 1;
    ctx.fillStyle = color;
    ctx.font = `700 9px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `${compass} ${pos.size || "?"}f`,
      lx,
      ly
    );
    ctx.globalAlpha = 1;

    hits.push({
      kind: "cable",
      x: pos.x,
      y: pos.y,
      r: 14,
      cable_guid: pos.guid,
      label: `${compass} ${pos.size || "?"}f`,
    });
  }

  // Strand dots (after bridges so they sit on top)
  for (const [key, fp] of fiberPos) {
    const [guid, fstr] = key.split("|");
    const fn = Number(fstr);
    const lit = isEndpointFocused(focus, guid, fn);
    const dim = focused && !lit;
    const isThrough = throughKeys.has(key);

    // Peer: prefer through-tap partner, else fuse peer
    let pairCable;
    let pairFiber;
    let role = "strand";
    if (tapTopo) {
      for (const t of tapTopo.through) {
        if (t.in.cable === guid && t.in.fiber === fn) {
          pairCable = t.out.cable;
          pairFiber = t.out.fiber;
          role = "through_in";
          break;
        }
        if (t.out.cable === guid && t.out.fiber === fn) {
          pairCable = t.in.cable;
          pairFiber = t.in.fiber;
          role = "through_pt";
          break;
        }
      }
      if (!pairCable) {
        for (const d of tapTopo.drops) {
          if (d.drop?.cable === guid && d.drop?.fiber === fn) {
            role = "drop";
            if (d.from) {
              pairCable = d.from.cable;
              pairFiber = d.from.fiber;
            }
            break;
          }
        }
      }
    }
    if (!pairCable) {
      for (const p of fusePairs) {
        if (p.a.cable === guid && p.a.fiber === fn) {
          pairCable = p.b.cable;
          pairFiber = p.b.fiber;
          break;
        }
        if (p.b.cable === guid && p.b.fiber === fn) {
          pairCable = p.a.cable;
          pairFiber = p.a.fiber;
          break;
        }
      }
    }

    ctx.globalAlpha = dim ? 0.18 : 1;
    const baseR = fp.chipR || chipR;
    const rr = lit || isThrough ? baseR + Math.min(1.5, baseR * 0.35) : baseR;
    drawFiberChip(ctx, fp.x, fp.y, fn, rr);
    // Through-tap fibers get a permanent warm ring so they read vs fuse-only dots
    if (isThrough) {
      ctx.beginPath();
      ctx.arc(fp.x, fp.y, rr + 2.5, 0, Math.PI * 2);
      ctx.strokeStyle = role === "drop" ? MAG_DROP : MAG_THROUGH;
      ctx.lineWidth = lit ? 2.2 : 1.5;
      ctx.stroke();
    }
    if (lit) {
      ctx.beginPath();
      ctx.arc(fp.x, fp.y, rr + 3.5, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(241, 196, 15, 0.95)";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = MAG_TEXT;
      ctx.font = `700 8px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.fillText(`f${fn}`, fp.x, fp.y - rr - 4);
      if (pairFiber != null) {
        ctx.fillStyle =
          role === "through_in" || role === "through_pt"
            ? MAG_THROUGH
            : role === "drop"
              ? MAG_DROP
              : "rgba(241, 196, 15, 0.85)";
        ctx.font = `600 7px system-ui, sans-serif`;
        ctx.textBaseline = "top";
        const tag =
          role === "through_in"
            ? `→ PT f${pairFiber}`
            : role === "through_pt"
              ? `← IN f${pairFiber}`
              : role === "drop"
                ? "← tap"
                : `↔ f${pairFiber}`;
        ctx.fillText(tag, fp.x, fp.y + rr + 3);
      }
    } else if (isThrough && !focused) {
      // Quiet always-on role tag for through fibers
      ctx.fillStyle = role === "drop" ? MAG_DROP : MAG_THROUGH;
      ctx.font = `700 6px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(
        role === "through_in" ? "IN" : role === "through_pt" ? "PT" : "D",
        fp.x,
        fp.y + rr + 2
      );
    }
    ctx.globalAlpha = 1;

    hits.push({
      kind: "fiber",
      x: fp.x,
      y: fp.y,
      r: rr + 5,
      cable_guid: guid,
      fiber: fn,
      pair_cable: pairCable,
      pair_fiber: pairFiber,
      role,
      label: `f${fn}`,
    });
  }

  // Open drop ports (minimal)
  if (isTap) {
    const openDrops = equipLinks.filter(
      (l) => l.role === "drop" && (!l.a || !layout.has(l.a.cable))
    );
    openDrops.slice(0, 4).forEach((l, i) => {
      const deg = normalizeDeg(135 + i * (openDrops.length > 1 ? 50 : 0));
      const u = approachUnit(deg);
      const x = cx + u.x * (railR * 0.9);
      const y = cy + u.y * (railR * 0.9);
      ctx.globalAlpha = focused ? 0.25 : 0.8;
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = MAG_DROP;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(cx + u.x * encR, cy + u.y * encR);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = MAG_MUTED;
      ctx.font = `600 8px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(l.drop_port != null ? `D${l.drop_port}` : "D", x, y + 12);
      ctx.globalAlpha = 1;
      hits.push({
        kind: "port",
        x,
        y,
        r: 10,
        role: "drop",
        label: l.port || "Drop",
      });
    });
  }

  // Quiet station id only
  if (detail.station_id) {
    ctx.fillStyle = "rgba(155, 167, 181, 0.55)";
    ctx.font = `8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(detail.station_id, cx, cy + r * 0.94);
  }

  return hits;
}

export function rgbaToCss(rgba) {
  const r = rgba & 0xff;
  const g = (rgba >> 8) & 0xff;
  const b = (rgba >> 16) & 0xff;
  return `rgb(${r},${g},${b})`;
}

/**
 * @param {object} [opts]
 * @param {{x:number,y:number}} [opts.pan]
 * @param {number} [opts.zoom] in-glass zoom multiplier
 * @param {object|null} [opts.focus]
 * @param {object|null} [opts.hoverHit]
 * @param {object|null} [opts.precomputed] decoded WSCH layout (P4.11)
 * @param {{layout:(d:object,g:object)=>object}|null} [opts.layoutService]
 * @param {string} [opts.layoutSource] "wasm" | "js" for chrome badge
 */
export function paintMagnifierContent(ctx, cx, cy, rCss, hit, detail, opts = {}) {
  const pan = opts.pan || { x: 0, y: 0 };
  const zoom = Math.max(0.5, Number(opts.zoom) || 1);
  const focus = opts.focus || null;
  let precomputed =
    opts.precomputed && opts.precomputed.ok ? opts.precomputed : null;
  let layoutSource = opts.layoutSource || (precomputed ? "wasm" : "js");
  const title = magnifierTitle(hit, detail);
  const worldScale = MAGNIFIER_WORLD_SCALE * zoom;
  /* Approx body radius before chrome (matches drawLensChrome margins) */
  const bodyRApprox = Math.max(24, rCss - 22);
  const localRApprox = bodyRApprox / worldScale;

  /* P4.11: WASM layout before chrome so footer can show source */
  if (
    !precomputed &&
    opts.layoutService &&
    detail &&
    (detail.cables?.length || detail.links?.length)
  ) {
    try {
      const res = opts.layoutService.layout(detail, {
        cx: 0,
        cy: 0,
        radius: localRApprox,
      });
      if (res?.ok) {
        precomputed = res;
        layoutSource = res.source || "wasm";
      } else {
        layoutSource = res?.source === "js" ? "js" : layoutSource;
      }
    } catch {
      layoutSource = "js";
    }
  }

  const mode = opts.mode || "inspect";
  let footer = "scroll/pinch zoom · tap fiber";
  if (hit.sp_guid && (hit.kind === "tap" || hit.kind === "splice")) {
    if (mode === "navigate") {
      footer = "drag glass along plant · hold = inspect";
    } else {
      footer =
        layoutSource === "wasm"
          ? "layout:wasm · zoom · tap fiber · hold = move glass"
          : "zoom strands · tap fiber · hold = move glass";
    }
  } else if (hit.kind === "cable" || hit.kind === "drop") {
    footer = "tap map cable for paths";
  }

  const { bodyTop, bodyBot } = drawLensChrome(ctx, cx, cy, rCss, title, footer);
  const bodyCy = (bodyTop + bodyBot) / 2;
  const bodyR = Math.max(24, (bodyBot - bodyTop) / 2);
  /** @type {MagHit[]} */
  let hits = [];

  ctx.save();
  ctx.translate(cx - pan.x, bodyCy - pan.y);
  ctx.scale(worldScale, worldScale);
  const localR = bodyR / worldScale;

  /* If exact body radius differs, re-layout once (cached by service) */
  if (
    precomputed &&
    opts.layoutService &&
    Math.abs(localR - localRApprox) > 0.5 &&
    detail
  ) {
    try {
      const res = opts.layoutService.layout(detail, {
        cx: 0,
        cy: 0,
        radius: localR,
      });
      if (res?.ok) {
        precomputed = res;
        layoutSource = res.source || "wasm";
      }
    } catch {
      /* keep prior */
    }
  }

  if (hit.kind === "cable" || hit.kind === "drop") {
    drawLineCallout(ctx, 0, 0, localR, hit);
    if (hit.cable_guid) {
      hits.push({
        kind: "cable",
        x: 0,
        y: 0,
        r: localR * 0.5,
        cable_guid: hit.cable_guid,
        label: "cable",
      });
    }
  } else if (
    detail &&
    (detail.cables?.length || detail.links?.length || detail.tap)
  ) {
    hits = drawGeoMeetSchematic(ctx, 0, 0, localR, detail, focus, {
      precomputed,
    });
  } else if (hit.kind === "tap") {
    drawTapEnlarged(ctx, 0, 0, localR, hit);
  } else if (hit.kind === "splice") {
    drawSpliceEnlarged(ctx, 0, 0, localR, hit);
  } else {
    drawLineCallout(ctx, 0, 0, localR, hit);
  }

  if (hit.sp_guid && detail === undefined) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("Loading…", 0, localR * 0.8);
  } else if (hit.sp_guid && detail === null) {
    ctx.fillStyle = MAG_HINT;
    ctx.font = `8px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.fillText("No schematic", 0, localR * 0.8);
  }

  ctx.restore();

  // Zoom badge (outside transform, bottom of glass interior)
  ctx.fillStyle = "rgba(107, 119, 133, 0.7)";
  ctx.font = `600 8px ui-monospace, monospace`;
  ctx.textAlign = "right";
  ctx.textBaseline = "bottom";
  ctx.fillText(`${zoom.toFixed(1)}×`, cx + rCss * 0.62, cy + rCss * 0.62);
  if (layoutSource === "wasm" && hit.sp_guid) {
    ctx.textAlign = "left";
    ctx.fillStyle = "rgba(126, 182, 255, 0.75)";
    ctx.fillText("wasm", cx - rCss * 0.62, cy + rCss * 0.62);
  }

  const mapped = hits.map((h) => ({
    ...h,
    lensX: h.x * worldScale - pan.x,
    lensY: h.y * worldScale + (bodyCy - cy) - pan.y,
    // Expand hit radius with zoom so chips stay clickable
    r: (h.r || 8) * Math.min(worldScale, 2.2),
  }));

  return {
    hits: mapped,
    worldScale,
    bodyCy,
    bodyR,
    pan: { ...pan },
    zoom,
  };
}

function magnifierTitle(hit, detail) {
  if (hit.kind === "tap") {
    const name = detail?.tap?.name;
    const ports = detail?.tap?.ports ?? hit.ports;
    const st = detail?.station_id;
    const loss = fmtLoss(detail?.tap?.loss_db);
    if (name) {
      const bits = [name];
      if (loss) bits.push(loss);
      else if (st) bits.push(st);
      return bits.join(" · ");
    }
    if (ports) return `Tap · ${ports} ports`;
    return "Tap";
  }
  if (hit.kind === "splice") {
    const st = detail?.station_id;
    const n = detail?.cables?.length;
    if (st) return st;
    return n ? `Splice · ${n} cables` : "Splice";
  }
  if (hit.kind === "drop") return "Drop fiber";
  if (hit.kind === "cable") return "Mainline cable";
  return "Fiber";
}
