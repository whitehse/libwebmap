/**
 * Fiber display layer: turns .fmap feature rows into WebGPU line meshes
 * and Canvas2D symbols (tap circles + non-tap splice hexagons).
 *
 * Data stays table-like (cables / drops / taps / splices).
 * Style lives in fiber_style.js. Click opens splice diagrams.
 * Hover (after dwell) opens a magnifying-glass detail lens.
 */

import {
  fiberMinZoom,
  styleLineWidthPx,
  styleOrder,
  styleTapRadiusPx,
  styleSpliceRadiusPx,
  diagramUrl,
  SPLICE_FILL,
  SPLICE_STROKE,
  FIBER_TAP_ZMIN_DEFAULT,
  FIBER_SPLICE_ZMIN_DEFAULT,
  LINE_HIT_PAD_PX,
} from "./fiber_style.js";
import { parseFmap } from "./fiber_fmap.js";
import { createFiberMagnifier } from "./fiber_magnifier.js";

const LINE_MITER_LIMIT = 2.5;
const R = 6378137;

/**
 * Resolve splice_detail/ base URL for lazy magnifier fetches.
 *
 * Manifest may store either:
 *   - path relative to fiber_data baseUrl: "./splice_detail/" (export tool)
 *   - page-relative path: "./fiber_data/splice_detail/"
 *   - absolute URL
 *
 * Older exports wrote "./splice_detail/" intending "under fiber_data", but the
 * browser resolves that against the demo page root and 404s — so relative
 * paths that do not already mention fiber_data are joined with baseUrl.
 *
 * @param {{splice_detail_url?: string}|null} man
 * @param {string} baseUrl e.g. "./fiber_data"
 */
export function resolveSpliceDetailBase(man, baseUrl) {
  const base = String(baseUrl || "./fiber_data").replace(/\/?$/, "/");
  const raw = man?.splice_detail_url;
  if (!raw) return base + "splice_detail/";
  const s = String(raw).trim();
  if (!s) return base + "splice_detail/";
  // Absolute http(s) or root-absolute
  if (/^https?:\/\//i.test(s) || s.startsWith("/")) {
    return s.replace(/\/?$/, "/");
  }
  // Already page-relative including fiber_data (or other full prefix)
  if (s.includes("fiber_data")) {
    return s.replace(/\/?$/, "/");
  }
  // Relative to fiber_data base (e.g. "./splice_detail/" or "splice_detail/")
  const rel = s.replace(/^\.\//, "");
  return base + rel.replace(/\/?$/, "/");
}

/* ── Geometry helpers (line extrusion) ─────────────────────────────── */

function leftNormal(dx, dy) {
  return [-dy, dx];
}

function unitDir(x0, y0, x1, y1) {
  let dx = x1 - x0;
  let dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  return [dx / len, dy / len];
}

function joinNormal(pts, i, n) {
  const x = pts[i * 2];
  const y = pts[i * 2 + 1];
  if (i === 0) {
    const d = unitDir(x, y, pts[2], pts[3]);
    if (!d) return [0, 0];
    return leftNormal(d[0], d[1]);
  }
  if (i === n - 1) {
    const d = unitDir(pts[(n - 2) * 2], pts[(n - 2) * 2 + 1], x, y);
    if (!d) return [0, 0];
    return leftNormal(d[0], d[1]);
  }
  const d0 = unitDir(pts[(i - 1) * 2], pts[(i - 1) * 2 + 1], x, y);
  const d1 = unitDir(x, y, pts[(i + 1) * 2], pts[(i + 1) * 2 + 1]);
  if (!d0 && !d1) return [0, 0];
  if (!d0) return leftNormal(d1[0], d1[1]);
  if (!d1) return leftNormal(d0[0], d0[1]);
  const n0 = leftNormal(d0[0], d0[1]);
  const n1 = leftNormal(d1[0], d1[1]);
  let mx = n0[0] + n1[0];
  let my = n0[1] + n1[1];
  const mlen = Math.hypot(mx, my);
  if (mlen < 1e-6) return n0;
  mx /= mlen;
  my /= mlen;
  const cos = mx * n0[0] + my * n0[1];
  if (cos < 1e-4) return n0;
  let scale = 1 / cos;
  if (scale > LINE_MITER_LIMIT) scale = LINE_MITER_LIMIT;
  return [mx * scale, my * scale];
}

function writeVertex(dv, i, x, y, nx, ny, rgba) {
  const o = i * 24;
  dv.setFloat32(o, x, true);
  dv.setFloat32(o + 4, y, true);
  dv.setFloat32(o + 8, nx, true);
  dv.setFloat32(o + 12, ny, true);
  dv.setUint32(o + 16, rgba, true);
  dv.setUint32(o + 20, 0, true);
}

function tileLocalToMerc(tile, extent, vx, vy) {
  const n = 2 ** tile.z;
  const size = (2 * Math.PI * R) / n;
  const lonW = (tile.x / n) * 360 - 180;
  const latN =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * tile.y) / n))) * 180) / Math.PI;
  const latS =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 1)) / n))) * 180) /
    Math.PI;
  const [ox] = lonLatToMerc(lonW, latS);
  const [, oyn] = lonLatToMerc(lonW, latN);
  const [, oys] = lonLatToMerc(lonW, latS);
  const h = oyn - oys;
  const mx = ox + (vx / extent) * size;
  const my = oyn - (vy / extent) * h;
  return [mx, my];
}

function lonLatToMerc(lon, lat) {
  const x = (R * lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

/* ── FiberLayer ────────────────────────────────────────────────────── */

/**
 * @param {{
 *   device: GPUDevice,
 *   labelCanvas: HTMLCanvasElement|null,
 *   log?: (s:string)=>void
 * }} opts
 */
export function createFiberLayer(opts) {
  const { device, labelCanvas, log = () => {} } = opts;
  const labelCtx = labelCanvas ? labelCanvas.getContext("2d") : null;

  /** @type {Map<string, object[]>} */
  const tileGpu = new Map();
  /** @type {Map<string, Array<{mx:number,my:number,ports:number,strand:number,tube:number,sp_guid:string}>>} */
  const tileTaps = new Map();
  /** @type {Map<string, Array<{mx:number,my:number,rgba:number,sp_guid:string}>>} */
  const tileSplices = new Map();
  /**
   * Line hit geometry (mercator polylines) per tile key.
   * @type {Map<string, Array<{kind:string,size:number,rgba:number,merc:Float32Array,n:number,id:string}>>}
   */
  const tileLines = new Map();

  /** Last painted hit targets in device pixels (canvas space). */
  /** @type {Array<{px:number,py:number,r:number,kind:string,sp_guid:string,ports?:number,strand?:number,tube?:number,mx:number,my:number}>} */
  let hitTargets = [];

  let availableZooms = [];
  let fiberZmin = 10;
  let fiberZmax = 14;
  let fiberTapZmin = FIBER_TAP_ZMIN_DEFAULT;
  let fiberSpliceZmin = FIBER_SPLICE_ZMIN_DEFAULT;
  let show = true;
  let manifest = null;
  /** Multiplier for fiber line opacity while path-trace is active (1 = normal). */
  let dimFactor = 1.0;
  /** @type {Record<string,string>|null} */
  let diagramIndex = null;
  let diagramsBase = "./splice_diagrams/";
  /** Last camera/view for pick without full repaint. */
  let lastPickCam = null;
  let lastPickView = null;
  let lastPickMppFn = null;

  const magnifier = createFiberMagnifier({ log });

  function createMesh(vertBuf, indices, indexCount, meta) {
    const vb = device.createBuffer({
      size: Math.max(vertBuf.byteLength, 24),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(vb.getMappedRange()).set(new Uint8Array(vertBuf));
    vb.unmap();
    const indBytes =
      indices instanceof Uint32Array
        ? indices.buffer.slice(
            indices.byteOffset,
            indices.byteOffset + indices.byteLength
          )
        : indices;
    const ib = device.createBuffer({
      size: Math.max(indexCount * 4, 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(ib.getMappedRange()).set(new Uint8Array(indBytes));
    ib.unmap();
    return { vb, ib, indexCount, ...meta };
  }

  function linesToMesh(tile, lines, kind) {
    if (!lines.length) return null;
    let totalPts = 0;
    let totalSegs = 0;
    for (const ln of lines) {
      if (ln.n_pts < 2) continue;
      totalPts += ln.n_pts;
      totalSegs += ln.n_pts - 1;
    }
    if (totalSegs <= 0) return null;

    const outVerts = new ArrayBuffer(totalPts * 2 * 24);
    const dv = new DataView(outVerts);
    const inds = new Uint32Array(totalSegs * 6);
    let vi = 0;
    let ii = 0;
    const extent = tile.extent || 4096;

    for (const ln of lines) {
      if (ln.n_pts < 2) continue;
      const merc = new Float32Array(ln.n_pts * 2);
      for (let i = 0; i < ln.n_pts; i++) {
        const [mx, my] = tileLocalToMerc(
          tile,
          extent,
          ln.xy[i * 2],
          ln.xy[i * 2 + 1]
        );
        merc[i * 2] = mx;
        merc[i * 2 + 1] = my;
      }
      const rgba = ln.rgba | 0xff000000;
      const base = vi;
      const n = ln.n_pts;
      for (let i = 0; i < n; i++) {
        const [nx, ny] = joinNormal(merc, i, n);
        writeVertex(dv, vi++, merc[i * 2], merc[i * 2 + 1], nx, ny, rgba);
        writeVertex(dv, vi++, merc[i * 2], merc[i * 2 + 1], -nx, -ny, rgba);
      }
      for (let i = 0; i < n - 1; i++) {
        const a = base + i * 2;
        const b = base + (i + 1) * 2;
        inds[ii++] = a;
        inds[ii++] = a + 1;
        inds[ii++] = b;
        inds[ii++] = a + 1;
        inds[ii++] = b + 1;
        inds[ii++] = b;
      }
    }
    if (vi === 0) return null;
    return createMesh(outVerts.slice(0, vi * 24), inds.slice(0, ii), ii, {
      name: "fiber/" + kind,
      kind: "line",
      fiberKind: kind,
      order: styleOrder(kind),
      minZoom: fiberMinZoom(kind),
      z: tile.z,
      x: tile.x,
      y: tile.y,
    });
  }

  function storeLineHits(tile, lines, kind, key) {
    if (!lines?.length) return;
    const extent = tile.extent || 4096;
    let list = tileLines.get(key);
    if (!list) {
      list = [];
      tileLines.set(key, list);
    }
    let idx = 0;
    for (const ln of lines) {
      if (ln.n_pts < 2) continue;
      const merc = new Float32Array(ln.n_pts * 2);
      for (let i = 0; i < ln.n_pts; i++) {
        const [mx, my] = tileLocalToMerc(
          tile,
          extent,
          ln.xy[i * 2],
          ln.xy[i * 2 + 1]
        );
        merc[i * 2] = mx;
        merc[i * 2 + 1] = my;
      }
      list.push({
        kind,
        size: ln.size | 0,
        rgba: ln.rgba | 0xff000000,
        merc,
        n: ln.n_pts,
        id: `${key}/${kind}/${idx++}`,
        cable_guid: ln.cable_guid || "",
      });
    }
  }

  function tileToGpu(feat) {
    const tile = { z: feat.z, x: feat.x, y: feat.y, extent: feat.extent };
    const layers = [];
    const cableMesh = linesToMesh(tile, feat.cables, "cable");
    if (cableMesh) layers.push(cableMesh);
    const dropMesh = linesToMesh(tile, feat.drops, "drop");
    if (dropMesh) layers.push(dropMesh);

    const key = `${feat.z}/${feat.x}/${feat.y}`;
    storeLineHits(tile, feat.cables, "cable", key);
    storeLineHits(tile, feat.drops, "drop", key);

    if (feat.taps?.length) {
      const taps = [];
      for (const t of feat.taps) {
        const [mx, my] = tileLocalToMerc(tile, feat.extent || 4096, t.x, t.y);
        taps.push({
          mx,
          my,
          ports: t.ports,
          strand: t.strand_rgba | 0xff000000,
          tube: t.tube_rgba | 0xff000000,
          sp_guid: t.sp_guid || "",
        });
      }
      tileTaps.set(key, taps);
    }
    if (feat.splices?.length) {
      const splices = [];
      for (const s of feat.splices) {
        const [mx, my] = tileLocalToMerc(tile, feat.extent || 4096, s.x, s.y);
        splices.push({
          mx,
          my,
          rgba: s.rgba | 0xff000000,
          sp_guid: s.sp_guid || "",
        });
      }
      tileSplices.set(key, splices);
    }

    layers.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
    return layers;
  }

  async function loadPyramid(man, baseUrl) {
    manifest = man;
    fiberZmin = man.zmin ?? 10;
    fiberZmax = man.zmax ?? 14;
    fiberTapZmin = man.tap_zmin ?? FIBER_TAP_ZMIN_DEFAULT;
    fiberSpliceZmin = man.splice_zmin ?? FIBER_SPLICE_ZMIN_DEFAULT;
    diagramsBase = man.diagrams_url || "./splice_diagrams/";
    // baseUrl is e.g. "./fiber_data" — compact connectivity JSON lives under splice_detail/
    magnifier.setDetailBase(resolveSpliceDetailBase(man, baseUrl));
    tileGpu.clear();
    tileTaps.clear();
    tileSplices.clear();
    tileLines.clear();
    hitTargets = [];
    magnifier.cancel();

    // Diagram index: guid → HTML basename
    diagramIndex = null;
    const idxName = man.diagram_index || "diagram_index.json";
    try {
      const ir = await fetch(`${baseUrl}/${idxName}`);
      if (ir.ok) {
        diagramIndex = await ir.json();
        log(
          `diagram index: ${Object.keys(diagramIndex).length} splicepoints`
        );
      }
    } catch (e) {
      log("diagram index load failed: " + e.message);
    }

    const byZoom = new Map();
    let loaded = 0;
    const queue = [...(man.tiles || [])];
    const workers = 8;

    async function worker() {
      while (queue.length) {
        const t = queue.shift();
        if (!t) break;
        const url = `${baseUrl}/${t.z}/${t.x}/${t.y}.fmap`;
        try {
          const r = await fetch(url);
          if (!r.ok) continue;
          const buf = await r.arrayBuffer();
          const feat = parseFmap(buf);
          const key = `${feat.z}/${feat.x}/${feat.y}`;
          const layers = tileToGpu(feat);
          if (layers.length || tileTaps.has(key) || tileSplices.has(key)) {
            if (layers.length) tileGpu.set(key, layers);
            if (!byZoom.has(feat.z)) byZoom.set(feat.z, 0);
            byZoom.set(feat.z, byZoom.get(feat.z) + 1);
            loaded++;
          }
        } catch (e) {
          log("fiber tile fail " + url + ": " + e.message);
        }
      }
    }
    await Promise.all(Array.from({ length: workers }, () => worker()));
    availableZooms = [...byZoom.keys()].sort((a, b) => a - b);
    return {
      loaded,
      total: man.tiles?.length ?? 0,
      byZoom,
      availableZooms,
      fiberZmin,
      fiberZmax,
      fiberTapZmin,
      fiberSpliceZmin,
      features: man.features,
    };
  }

  function selectFiberTileZoom(zoom) {
    if (!availableZooms.length) return null;
    const ideal = Math.min(fiberZmax, Math.max(fiberZmin, Math.floor(zoom)));
    let best = availableZooms[0];
    for (const z of availableZooms) {
      if (z <= ideal) best = z;
    }
    return best;
  }

  function visibleTileRange(z, cam, view, pad, metersPerPixelFn) {
    const mpp = metersPerPixelFn(cam.zoom);
    const [cx, cy] = lonLatToMerc(cam.lon, cam.lat);
    const halfW = mpp * (view.w / 2) * (1 + pad);
    const halfH = mpp * (view.h / 2) * (1 + pad);
    const n = 2 ** z;
    function mercToTileXY(mx, my) {
      const lon = (mx / R) * (180 / Math.PI);
      const lat =
        (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI);
      const fx = ((lon + 180) / 360) * n;
      const lat_r = (lat * Math.PI) / 180;
      const fy =
        ((1 - Math.log(Math.tan(lat_r) + 1 / Math.cos(lat_r)) / Math.PI) / 2) *
        n;
      return [fx, fy];
    }
    const [x0, y0] = mercToTileXY(cx - halfW, cy + halfH);
    const [x1, y1] = mercToTileXY(cx + halfW, cy - halfH);
    return {
      minX: Math.max(0, Math.floor(Math.min(x0, x1))),
      maxX: Math.min(n - 1, Math.floor(Math.max(x0, x1))),
      minY: Math.max(0, Math.floor(Math.min(y0, y1))),
      maxY: Math.min(n - 1, Math.floor(Math.max(y0, y1))),
    };
  }

  function collectLineDraws(draws, cam, view, metersPerPixelFn) {
    if (!show || !tileGpu.size) return;
    const fz = selectFiberTileZoom(cam.zoom);
    if (fz == null) return;
    const fr = visibleTileRange(fz, cam, view, 0.25, metersPerPixelFn);
    for (let x = fr.minX; x <= fr.maxX; x++) {
      for (let y = fr.minY; y <= fr.maxY; y++) {
        const layers = tileGpu.get(`${fz}/${x}/${y}`);
        if (!layers) continue;
        for (const g of layers) {
          const minZ = g.minZoom ?? fiberMinZoom(g.fiberKind);
          if (cam.zoom + 0.01 < minZ) continue;
          draws.push(g);
        }
      }
    }
  }

  function rgbaToCss(rgba) {
    const r = rgba & 0xff;
    const g = (rgba >> 8) & 0xff;
    const b = (rgba >> 16) & 0xff;
    return `rgb(${r},${g},${b})`;
  }

  /** Pointy-top hexagon (splice enclosure). r = center-to-vertex radius. */
  function drawHexagon(ctx, px, py, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      // Start at top vertex (−90°) so the flat sides read as an enclosure.
      const a = -Math.PI / 2 + (i * Math.PI) / 3;
      const x = px + r * Math.cos(a);
      const y = py + r * Math.sin(a);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /**
   * Paint tap circles + splice hexagons on the label canvas (screen-space).
   * Rebuilds hitTargets for click/hover handling; paints magnifier last.
   */
  function paintSymbols(cam, view, metersPerPixelFn) {
    hitTargets = [];
    lastPickCam = cam;
    lastPickView = view;
    lastPickMppFn = metersPerPixelFn;
    if (!labelCtx || !labelCanvas) return;
    const w = labelCanvas.width;
    const h = labelCanvas.height;
    if (!show) {
      magnifier.paint(labelCtx, view);
      return;
    }

    const showTaps = cam.zoom + 0.01 >= fiberTapZmin;
    const showSplices = cam.zoom + 0.01 >= fiberSpliceZmin;

    const fz = selectFiberTileZoom(cam.zoom);
    if (fz == null) {
      magnifier.paint(labelCtx, view);
      return;
    }
    const mpp = metersPerPixelFn(cam.zoom);
    const [cx, cy] = lonLatToMerc(cam.lon, cam.lat);
    const sx = 1 / (mpp * (view.w / 2));
    const sy = 1 / (mpp * (view.h / 2));
    const dpr = view.dpr || 1;

    const rTapPx = styleTapRadiusPx(cam.zoom);
    const rTap = rTapPx * dpr;
    const fontPx = Math.max(8, rTapPx * 1.15) * dpr;
    const rSplPx = styleSpliceRadiusPx(cam.zoom);
    const rSpl = rSplPx * dpr;

    const fr = visibleTileRange(fz, cam, view, 0.25, metersPerPixelFn);
    const seenTap = new Set();
    const seenSpl = new Set();

    labelCtx.save();
    labelCtx.font = `600 ${fontPx}px system-ui, sans-serif`;
    labelCtx.textAlign = "center";
    labelCtx.textBaseline = "middle";
    labelCtx.lineJoin = "round";
    labelCtx.lineCap = "round";

    function toScreen(mx, my) {
      const ndcX = (mx - cx) * sx;
      const ndcY = (my - cy) * sy;
      return [(ndcX * 0.5 + 0.5) * w, (-ndcY * 0.5 + 0.5) * h];
    }

    // Splices under taps (taps drawn later on top)
    if (showSplices) {
      for (let x = fr.minX; x <= fr.maxX; x++) {
        for (let y = fr.minY; y <= fr.maxY; y++) {
          const splices = tileSplices.get(`${fz}/${x}/${y}`);
          if (!splices) continue;
          for (const s of splices) {
            const key = `${(s.mx / 5) | 0},${(s.my / 5) | 0}`;
            if (seenSpl.has(key)) continue;
            seenSpl.add(key);
            const [px, py] = toScreen(s.mx, s.my);
            if (
              px < -rSpl * 2 ||
              py < -rSpl * 2 ||
              px > w + rSpl * 2 ||
              py > h + rSpl * 2
            )
              continue;

            // Hexagon enclosure (distinct from circular taps; no + mark)
            drawHexagon(labelCtx, px, py, rSpl);
            labelCtx.fillStyle = SPLICE_FILL;
            labelCtx.fill();
            labelCtx.lineWidth = Math.max(1.5, rSpl * 0.22);
            labelCtx.strokeStyle = SPLICE_STROKE;
            labelCtx.stroke();

            hitTargets.push({
              px,
              py,
              r: rSpl * 1.15,
              kind: "splice",
              sp_guid: s.sp_guid || "",
              mx: s.mx,
              my: s.my,
            });
          }
        }
      }
    }

    if (showTaps) {
      for (let x = fr.minX; x <= fr.maxX; x++) {
        for (let y = fr.minY; y <= fr.maxY; y++) {
          const taps = tileTaps.get(`${fz}/${x}/${y}`);
          if (!taps) continue;
          for (const t of taps) {
            const key = `${(t.mx / 5) | 0},${(t.my / 5) | 0}`;
            if (seenTap.has(key)) continue;
            seenTap.add(key);
            const [px, py] = toScreen(t.mx, t.my);
            if (
              px < -rTap * 2 ||
              py < -rTap * 2 ||
              px > w + rTap * 2 ||
              py > h + rTap * 2
            )
              continue;

            labelCtx.beginPath();
            labelCtx.arc(px, py, rTap, 0, Math.PI * 2);
            labelCtx.fillStyle = rgbaToCss(t.strand);
            labelCtx.fill();
            labelCtx.lineWidth = Math.max(1.5, rTap * 0.22);
            labelCtx.strokeStyle = rgbaToCss(t.tube);
            labelCtx.stroke();

            if (rTapPx >= 4 && t.ports > 0) {
              const text = String(t.ports);
              labelCtx.lineWidth = Math.max(2, fontPx * 0.18);
              labelCtx.strokeStyle = "rgba(0,0,0,0.55)";
              labelCtx.fillStyle = "#ffffff";
              labelCtx.strokeText(text, px, py);
              labelCtx.fillText(text, px, py);
            }

            hitTargets.push({
              px,
              py,
              r: rTap * 1.15,
              kind: "tap",
              sp_guid: t.sp_guid || "",
              ports: t.ports,
              strand: t.strand,
              tube: t.tube,
              mx: t.mx,
              my: t.my,
            });
          }
        }
      }
    }

    labelCtx.restore();

    // Magnifier lens on top of symbols
    magnifier.paint(labelCtx, view);
  }

  /** Distance from point to segment (device px space). */
  function distToSeg(px, py, x0, y0, x1, y1) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const len2 = dx * dx + dy * dy;
    if (len2 < 1e-12) return Math.hypot(px - x0, py - y0);
    let t = ((px - x0) * dx + (py - y0) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = x0 + t * dx;
    const qy = y0 + t * dy;
    return Math.hypot(px - qx, py - qy);
  }

  /**
   * Pick feature under CSS canvas coordinates.
   * Priority: tap > splice > drop > cable.
   * @returns {object|null}
   */
  function pick(cssX, cssY, view, cam, metersPerPixelFn) {
    if (!show) return null;
    const v = view || lastPickView;
    const c = cam || lastPickCam;
    const mppFn = metersPerPixelFn || lastPickMppFn;
    if (!v || !c || !mppFn) return null;

    const dpr = v.dpr || (labelCanvas ? labelCanvas.width / (v.w || 1) : 1);
    const px = cssX * dpr;
    const py = cssY * dpr;

    // Points first (higher priority)
    let bestPt = null;
    let bestPtD = Infinity;
    for (const h of hitTargets) {
      const d = Math.hypot(px - h.px, py - h.py);
      if (d <= h.r && d < bestPtD) {
        bestPtD = d;
        bestPt = h;
      }
    }
    if (bestPt) {
      return {
        kind: bestPt.kind,
        sp_guid: bestPt.sp_guid || "",
        ports: bestPt.ports,
        strand: bestPt.strand,
        tube: bestPt.tube,
        mx: bestPt.mx,
        my: bestPt.my,
        screenCssX: bestPt.px / dpr,
        screenCssY: bestPt.py / dpr,
      };
    }

    // Lines
    const fz = selectFiberTileZoom(c.zoom);
    if (fz == null) return null;
    const mpp = mppFn(c.zoom);
    const [cx, cy] = lonLatToMerc(c.lon, c.lat);
    const sx = 1 / (mpp * (v.w / 2));
    const sy = 1 / (mpp * (v.h / 2));
    const w = (labelCanvas && labelCanvas.width) || v.w * dpr;
    const h = (labelCanvas && labelCanvas.height) || v.h * dpr;

    function toScreen(mx, my) {
      const ndcX = (mx - cx) * sx;
      const ndcY = (my - cy) * sy;
      return [(ndcX * 0.5 + 0.5) * w, (-ndcY * 0.5 + 0.5) * h];
    }

    const fr = visibleTileRange(fz, c, v, 0.15, mppFn);
    let bestLine = null;
    let bestLineD = Infinity;

    for (let x = fr.minX; x <= fr.maxX; x++) {
      for (let y = fr.minY; y <= fr.maxY; y++) {
        const lines = tileLines.get(`${fz}/${x}/${y}`);
        if (!lines) continue;
        for (const ln of lines) {
          const minZ = fiberMinZoom(ln.kind);
          if (c.zoom + 0.01 < minZ) continue;
          const halfPx =
            styleLineWidthPx(ln.kind, c.zoom) * 0.5 * dpr +
            LINE_HIT_PAD_PX * dpr;
          const merc = ln.merc;
          for (let i = 0; i < ln.n - 1; i++) {
            const [x0, y0] = toScreen(merc[i * 2], merc[i * 2 + 1]);
            const [x1, y1] = toScreen(merc[(i + 1) * 2], merc[(i + 1) * 2 + 1]);
            // cheap bbox reject
            const minx = Math.min(x0, x1) - halfPx;
            const maxx = Math.max(x0, x1) + halfPx;
            const miny = Math.min(y0, y1) - halfPx;
            const maxy = Math.max(y0, y1) + halfPx;
            if (px < minx || px > maxx || py < miny || py > maxy) continue;
            const d = distToSeg(px, py, x0, y0, x1, y1);
            if (d > halfPx) continue;
            // Prefer drop over cable; then closer
            const prio = ln.kind === "drop" ? 0 : 1;
            const bestPrio =
              bestLine == null ? 99 : bestLine.kind === "drop" ? 0 : 1;
            if (
              prio < bestPrio ||
              (prio === bestPrio && d < bestLineD)
            ) {
              bestLineD = d;
              // Closest point on segment for anchor
              const dx = x1 - x0;
              const dy = y1 - y0;
              const len2 = dx * dx + dy * dy;
              let t = len2 < 1e-12 ? 0 : ((px - x0) * dx + (py - y0) * dy) / len2;
              t = Math.max(0, Math.min(1, t));
              const apx = x0 + t * dx;
              const apy = y0 + t * dy;
              const mx = merc[i * 2] * (1 - t) + merc[(i + 1) * 2] * t;
              const my = merc[i * 2 + 1] * (1 - t) + merc[(i + 1) * 2 + 1] * t;
              bestLine = {
                kind: ln.kind,
                cable_size: ln.size,
                rgba: ln.rgba,
                line_id: ln.id,
                cable_guid: ln.cable_guid || "",
                mx,
                my,
                screenCssX: apx / dpr,
                screenCssY: apy / dpr,
              };
            }
          }
        }
      }
    }
    return bestLine;
  }

  /**
   * Hit-test a click in CSS canvas coordinates (same space as getBoundingClientRect).
   * @returns {{kind:string,sp_guid:string,url:string}|null}
   */
  function hitTest(cssX, cssY, view) {
    const p = pick(cssX, cssY, view, lastPickCam, lastPickMppFn);
    if (!p || !p.sp_guid) return null;
    if (p.kind !== "tap" && p.kind !== "splice") return null;
    const url = diagramUrl(p.sp_guid, diagramIndex, diagramsBase);
    if (!url) return null;
    return { kind: p.kind, sp_guid: p.sp_guid, url };
  }

  /** Open splice diagram for a hit; returns true if opened. */
  function handleClick(cssX, cssY, view) {
    const hit = hitTest(cssX, cssY, view);
    if (!hit) return false;
    window.open(hit.url, "_blank", "noopener,noreferrer");
    log(`open ${hit.kind} diagram ${hit.sp_guid.slice(0, 8)}…`);
    return true;
  }

  /**
   * Hover handling. Returns true if pointer is over a pickable feature
   * (for cursor style).
   */
  function handleHover(cssX, cssY, view, cam, metersPerPixelFn, dragging) {
    if (dragging || !show) {
      magnifier.onPointer(null, cssX, cssY, view, true);
      return false;
    }
    const hit = pick(cssX, cssY, view, cam, metersPerPixelFn);
    magnifier.onPointer(hit, cssX, cssY, view, false);
    return !!hit;
  }

  function cancelHover() {
    magnifier.cancel();
  }

  function halfWidthForDraw(g, cam, mpp) {
    if (g.kind === "line" && g.fiberKind) {
      return styleLineWidthPx(g.fiberKind, cam.zoom) * 0.5 * mpp;
    }
    return null;
  }

  return {
    loadPyramid,
    collectLineDraws,
    paintSymbols,
    halfWidthForDraw,
    selectFiberTileZoom,
    hitTest,
    pick,
    handleClick,
    handleHover,
    cancelHover,
    setShow(v) {
      show = !!v;
      if (!show) magnifier.cancel();
    },
    setDimFactor(f) {
      const x = Number(f);
      dimFactor = Number.isFinite(x) ? Math.max(0.05, Math.min(1, x)) : 1.0;
    },
    get dimFactor() {
      return dimFactor;
    },
    get show() {
      return show;
    },
    get availableZooms() {
      return availableZooms;
    },
    get fiberZmin() {
      return fiberZmin;
    },
    get fiberZmax() {
      return fiberZmax;
    },
    get fiberTapZmin() {
      return fiberTapZmin;
    },
    get fiberSpliceZmin() {
      return fiberSpliceZmin;
    },
    get size() {
      return tileGpu.size;
    },
    get manifest() {
      return manifest;
    },
    get magnifierOpen() {
      return magnifier.isOpen;
    },
  };
}
