/**
 * Fiber display layer: turns .fmap feature rows into WebGPU line meshes
 * and Canvas2D symbols (tap circles + non-tap splice hexagons).
 *
 * Data stays table-like (cables / drops / taps / splices).
 * Style lives in fiber_style.js.
 * Single-click on tap/splice opens the meet-point glass; double-click / long-
 * press opens the full HTML splice diagram.
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
import {
  estimateFiberGeomBytes,
  estimateDetailCacheBytes,
} from "./mem_stats.js";
import {
  createTileCache,
  destroyGpuLayers,
  parseMaxTilesQuery,
} from "./tile_cache.js";

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
  const {
    device,
    labelCanvas,
    log = () => {},
    onTrace = null,
    onOpenDiagram = null,
    requestPaint = null,
    memStats = null,
    maxTiles = null,
    layoutService = null,
  } = opts;
  const labelCtx = labelCanvas ? labelCanvas.getContext("2d") : null;

  const hostMaxTiles =
    maxTiles != null && Number.isFinite(maxTiles)
      ? Math.floor(maxTiles)
      : parseMaxTilesQuery();

  /** @type {Map<string, Array<{mx:number,my:number,ports:number,strand:number,tube:number,sp_guid:string}>>} */
  const tileTaps = new Map();
  /** @type {Map<string, Array<{mx:number,my:number,rgba:number,sp_guid:string}>>} */
  const tileSplices = new Map();
  /**
   * Line hit geometry (mercator polylines) per tile key.
   * @type {Map<string, Array<{kind:string,size:number,rgba:number,merc:Float32Array,n:number,id:string}>>}
   */
  const tileLines = new Map();

  function dropTileSideData(key) {
    tileTaps.delete(key);
    tileSplices.delete(key);
    tileLines.delete(key);
  }

  const fiberCache = createTileCache({
    maxTiles: hostMaxTiles,
    name: "fiber",
    onEvict: (key, layers) => {
      const b = destroyGpuLayers(/** @type {object[]} */ (layers));
      if (b && memStats) memStats.subGpu("fiber_gpu", b);
      dropTileSideData(key);
    },
    /* Reload must free old GPU only — side Maps already rewritten by tileToGpu. */
    onReplace: (_key, layers) => {
      const b = destroyGpuLayers(/** @type {object[]} */ (layers));
      if (b && memStats) memStats.subGpu("fiber_gpu", b);
    },
  });

  /** Package tile keys available on disk. */
  const fiberAvailable = new Set();
  /** @type {Map<string, Promise<void>>} */
  const fiberInflight = new Map();
  let fiberBaseUrl = "./fiber_data";
  let fiberEnsureGen = 0;

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

  /**
   * Estimate cable approach bearings from loaded fmap geometry near a SP.
   * approach_deg: 0=N, 90=E (mercator: +x east, +y north).
   * @returns {Map<string, number>} cable_guid → degrees
   */
  function approachesNear(mx, my, maxDistM = 120) {
    /** @type {Map<string, {deg:number, d2:number}>} */
    const best = new Map();
    if (mx == null || my == null) return new Map();
    const maxD2 = maxDistM * maxDistM;
    const sampleM = 45;

    for (const lines of tileLines.values()) {
      for (const ln of lines) {
        const guid = ln.cable_guid;
        if (!guid || !ln.merc || ln.n < 2) continue;
        const merc = ln.merc;
        let nearestI = 0;
        let nearestD2 = Infinity;
        for (let i = 0; i < ln.n; i++) {
          const dx = merc[i * 2] - mx;
          const dy = merc[i * 2 + 1] - my;
          const d2 = dx * dx + dy * dy;
          if (d2 < nearestD2) {
            nearestD2 = d2;
            nearestI = i;
          }
        }
        if (nearestD2 > maxD2) continue;

        // Walk along polyline to sample point away from SP
        function walk(dir) {
          let acc = 0;
          let i = nearestI;
          let px = merc[i * 2];
          let py = merc[i * 2 + 1];
          while (i + dir >= 0 && i + dir < ln.n) {
            i += dir;
            const x = merc[i * 2];
            const y = merc[i * 2 + 1];
            const step = Math.hypot(x - px, y - py);
            if (step < 1e-6) continue;
            acc += step;
            px = x;
            py = y;
            if (acc >= sampleM) return [x, y];
          }
          return acc > 1e-3 ? [px, py] : null;
        }
        const a = walk(1);
        const b = walk(-1);
        let sample = a;
        if (a && b) {
          const da = (a[0] - mx) ** 2 + (a[1] - my) ** 2;
          const db = (b[0] - mx) ** 2 + (b[1] - my) ** 2;
          sample = da >= db ? a : b;
        } else {
          sample = a || b;
        }
        if (!sample) continue;
        const dx = sample[0] - mx;
        const dy = sample[1] - my;
        if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue;
        // mercator: +x east, +y north → 0°N 90°E
        let deg = (Math.atan2(dx, dy) * 180) / Math.PI;
        if (deg < 0) deg += 360;
        const prev = best.get(guid);
        if (!prev || nearestD2 < prev.d2) {
          best.set(guid, { deg, d2: nearestD2 });
        }
      }
    }
    const out = new Map();
    for (const [g, v] of best) out.set(g, Math.round(v.deg * 10) / 10);
    return out;
  }

  function approachLabelFromDeg(deg) {
    const d = ((Number(deg) % 360) + 360) % 360;
    const snapped = (Math.round(d / 45) * 45) % 360;
    let ad = Math.abs(d - snapped);
    if (ad > 180) ad = 360 - ad;
    if (ad < 3) {
      const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
      return labels[Math.round(d / 45) % 8];
    }
    return `${Math.round(d)}°`;
  }

  function enrichDetail(hit, detail) {
    if (!detail || !detail.cables) return detail;
    const need = detail.cables.some((c) => c.approach_deg == null);
    if (!need && detail.cables.every((c) => c.approach != null)) return detail;
    const map = approachesNear(hit.mx, hit.my);
    if (!map.size) return detail;
    const cables = detail.cables.map((c) => {
      if (c.approach_deg != null) return c;
      const g = String(c.guid || "").toLowerCase();
      // map may be keyed as stored in fmap
      let deg = map.get(c.guid) ?? map.get(g);
      if (deg == null) {
        for (const [k, v] of map) {
          if (String(k).toLowerCase() === g) {
            deg = v;
            break;
          }
        }
      }
      if (deg == null) return c;
      return {
        ...c,
        approach_deg: deg,
        approach: approachLabelFromDeg(deg),
      };
    });
    return { ...detail, cables };
  }

  /**
   * Nearest tap/splice to a mercator point (for glass navigate mode).
   * @param {number} mx
   * @param {number} my
   * @param {number} [maxDistM=80]
   */
  function pickNearestSp(mx, my, maxDistM = 80) {
    if (mx == null || my == null) return null;
    const maxD2 = maxDistM * maxDistM;
    let best = null;
    let bestD2 = Infinity;
    for (const taps of tileTaps.values()) {
      for (const t of taps) {
        const dx = t.mx - mx;
        const dy = t.my - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2 && d2 <= maxD2) {
          bestD2 = d2;
          best = {
            kind: "tap",
            sp_guid: t.sp_guid || "",
            ports: t.ports,
            strand: t.strand,
            tube: t.tube,
            mx: t.mx,
            my: t.my,
          };
        }
      }
    }
    for (const splices of tileSplices.values()) {
      for (const s of splices) {
        const dx = s.mx - mx;
        const dy = s.my - my;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2 && d2 <= maxD2) {
          bestD2 = d2;
          best = {
            kind: "splice",
            sp_guid: s.sp_guid || "",
            mx: s.mx,
            my: s.my,
          };
        }
      }
    }
    return best;
  }

  const magnifier = createFiberMagnifier({
    log,
    enrichDetail,
    onTrace: (guid, fiber) => {
      if (typeof onTrace === "function") onTrace(guid, fiber);
    },
    onOpenDiagram: (spGuid) => {
      if (typeof onOpenDiagram === "function") onOpenDiagram(spGuid);
      else {
        const url = diagramUrl(spGuid, diagramIndex, diagramsBase);
        if (url) window.open(url, "_blank", "noopener,noreferrer");
      }
    },
    requestPaint: () => {
      if (typeof requestPaint === "function") requestPaint();
    },
    memStats,
    layoutService,
    pickNearestSp,
  });

  function createMesh(vertBuf, indices, indexCount, meta) {
    const vbSize = Math.max(vertBuf.byteLength, 24);
    const vb = device.createBuffer({
      size: vbSize,
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
    const ibSize = Math.max(indexCount * 4, 4);
    const ib = device.createBuffer({
      size: ibSize,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(ib.getMappedRange()).set(new Uint8Array(indBytes));
    ib.unmap();
    const gpuBytes = vbSize + ibSize;
    if (memStats) memStats.addGpu("fiber_gpu", gpuBytes);
    return { vb, ib, indexCount, _gpuBytes: gpuBytes, ...meta };
  }

  function refreshMemStats() {
    if (!memStats) return;
    memStats.setCount("fiber_tiles", fiberCache.size);
    memStats.setRetained(
      "fiber_geom_js",
      estimateFiberGeomBytes(tileLines, tileTaps, tileSplices)
    );
    const detail = magnifier.getDetailCache?.();
    if (detail) {
      memStats.setRetained(
        "splice_detail_js",
        estimateDetailCacheBytes(detail)
      );
      memStats.setCount("splice_detail_entries", detail.size);
    }
  }

  function getMemReport() {
    return {
      fiber_tiles: fiberCache.size,
      max_tiles: fiberCache.maxTiles,
      evictions: fiberCache.evictions,
      fiber_geom_js: estimateFiberGeomBytes(tileLines, tileTaps, tileSplices),
      splice_detail: magnifier.getMemReport?.() ?? null,
      line_tile_keys: tileLines.size,
      tap_tile_keys: tileTaps.size,
      splice_tile_keys: tileSplices.size,
      package_tiles: fiberAvailable.size,
    };
  }

  /**
   * @param {string} key
   */
  async function loadFiberTile(key) {
    if (fiberInflight.has(key) || fiberCache.has(key)) return;
    if (!fiberAvailable.has(key)) return;
    const parts = key.split("/");
    const z = Number(parts[0]);
    const x = Number(parts[1]);
    const y = Number(parts[2]);
    const url = `${fiberBaseUrl}/${z}/${x}/${y}.fmap`;
    const p = (async () => {
      try {
        const r = await fetch(url);
        if (!r.ok) return;
        const buf = await r.arrayBuffer();
        const feat = parseFmap(buf);
        const k = `${feat.z}/${feat.x}/${feat.y}`;
        const layers = tileToGpu(feat);
        if (layers.length || tileTaps.has(k) || tileSplices.has(k)) {
          fiberCache.set(k, layers.length ? layers : []);
        }
      } catch (e) {
        log("fiber tile fail " + url + ": " + e.message);
      } finally {
        fiberInflight.delete(key);
      }
    })();
    fiberInflight.set(key, p);
    await p;
  }

  /**
   * Lazy-load fiber tiles for viewport (P4.2).
   * @returns {Promise<void>}
   */
  function ensureVisibleTiles(cam, view, metersPerPixelFn) {
    if (!show || !fiberAvailable.size) return Promise.resolve();
    const fz = selectFiberTileZoom(cam.zoom);
    if (fz == null) return Promise.resolve();
    const fr = visibleTileRange(fz, cam, view, 0.35, metersPerPixelFn);
    const gen = ++fiberEnsureGen;
    const jobs = [];
    for (let x = fr.minX; x <= fr.maxX; x++) {
      for (let y = fr.minY; y <= fr.maxY; y++) {
        const key = `${fz}/${x}/${y}`;
        if (!fiberAvailable.has(key)) continue;
        if (fiberCache.has(key)) {
          fiberCache.touch(key);
          continue;
        }
        if (fiberInflight.has(key)) {
          jobs.push(fiberInflight.get(key));
          continue;
        }
        jobs.push(loadFiberTile(key));
      }
    }
    if (!jobs.length) return Promise.resolve();
    return Promise.all(jobs).then(() => {
      if (gen !== fiberEnsureGen) return;
      refreshMemStats();
    });
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

  async function loadPyramid(man, baseUrlIn) {
    manifest = man;
    fiberBaseUrl = (baseUrlIn || "./fiber_data").replace(/\/?$/, "");
    fiberZmin = man.zmin ?? 10;
    fiberZmax = man.zmax ?? 14;
    fiberTapZmin = man.tap_zmin ?? FIBER_TAP_ZMIN_DEFAULT;
    fiberSpliceZmin = man.splice_zmin ?? FIBER_SPLICE_ZMIN_DEFAULT;
    diagramsBase = man.diagrams_url || "./splice_diagrams/";
    magnifier.setDetailBase(resolveSpliceDetailBase(man, fiberBaseUrl));
    fiberCache.clear();
    fiberAvailable.clear();
    fiberInflight.clear();
    tileTaps.clear();
    tileSplices.clear();
    tileLines.clear();
    hitTargets = [];
    magnifier.cancel();

    // Diagram index: guid → HTML basename
    diagramIndex = null;
    const idxName = man.diagram_index || "diagram_index.json";
    try {
      const ir = await fetch(`${fiberBaseUrl}/${idxName}`);
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
    for (const t of man.tiles || []) {
      const key = `${t.z}/${t.x}/${t.y}`;
      fiberAvailable.add(key);
      if (!byZoom.has(t.z)) byZoom.set(t.z, 0);
      byZoom.set(t.z, byZoom.get(t.z) + 1);
    }
    availableZooms = [...byZoom.keys()].sort((a, b) => a - b);
    refreshMemStats();
    const total = fiberAvailable.size;
    log(
      `fiber package ${total} tiles (z ${availableZooms.join(",") || "—"}) · ` +
        (hostMaxTiles > 0 ? `max_tiles=${hostMaxTiles}` : "max_tiles=∞") +
        " (P4.2 lazy — viewport load)"
    );
    return {
      loaded: 0,
      total,
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
    if (!show || !fiberCache.size) return;
    const fz = selectFiberTileZoom(cam.zoom);
    if (fz == null) return;
    const fr = visibleTileRange(fz, cam, view, 0.25, metersPerPixelFn);
    for (let x = fr.minX; x <= fr.maxX; x++) {
      for (let y = fr.minY; y <= fr.maxY; y++) {
        const layers = fiberCache.get(`${fz}/${x}/${y}`);
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
  /**
   * @param {object} cam
   * @param {object} view
   * @param {Function} metersPerPixelFn
   * @param {{ magnifierChrome?: "canvas"|"gpu"|"none" }} [paintOpts]
   */
  function paintSymbols(cam, view, metersPerPixelFn, paintOpts = {}) {
    hitTargets = [];
    lastPickCam = cam;
    lastPickView = view;
    lastPickMppFn = metersPerPixelFn;
    if (!labelCtx || !labelCanvas) return;
    const w = labelCanvas.width;
    const h = labelCanvas.height;
    const magChrome = paintOpts.magnifierChrome || "canvas";
    const mpp = metersPerPixelFn(cam.zoom);
    const [cx, cy] = lonLatToMerc(cam.lon, cam.lat);
    const sx = 1 / (mpp * (view.w / 2));
    const sy = 1 / (mpp * (view.h / 2));
    const dpr = view.dpr || 1;

    function toScreen(mx, my) {
      const ndcX = (mx - cx) * sx;
      const ndcY = (my - cy) * sy;
      return [(ndcX * 0.5 + 0.5) * w, (-ndcY * 0.5 + 0.5) * h];
    }

    // Always refresh glass map projection (even when fiber symbols are off)
    magnifier.setProjection({
      toScreenCss: (mx, my) => {
        const [px, py] = toScreen(mx, my);
        return [px / dpr, py / dpr];
      },
      screenToMerc: (cssX, cssY) => {
        const ndcX = (cssX / (view.w || 1)) * 2 - 1;
        const ndcY = 1 - (cssY / (view.h || 1)) * 2;
        return [cx + ndcX / sx, cy + ndcY / sy];
      },
      view,
    });

    if (!show) {
      magnifier.paint(labelCtx, view, { chrome: magChrome });
      return;
    }

    const showTaps = cam.zoom + 0.01 >= fiberTapZmin;
    const showSplices = cam.zoom + 0.01 >= fiberSpliceZmin;

    const fz = selectFiberTileZoom(cam.zoom);
    if (fz == null) {
      magnifier.paint(labelCtx, view, { chrome: magChrome });
      return;
    }

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

    // Magnifier lens on top of symbols (chrome may be WebGPU — P4.12)
    magnifier.paint(labelCtx, view, { chrome: magChrome });
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

  /**
   * Open full HTML splice diagram for a SP guid.
   * @returns {boolean}
   */
  function openDiagram(spGuid) {
    if (!spGuid) return false;
    if (typeof onOpenDiagram === "function") {
      onOpenDiagram(spGuid);
      return true;
    }
    const url = diagramUrl(spGuid, diagramIndex, diagramsBase);
    if (!url) return false;
    window.open(url, "_blank", "noopener,noreferrer");
    log(`open diagram ${spGuid.slice(0, 8)}…`);
    return true;
  }

  /**
   * Click handling:
   *  - Inside glass → fiber trace / double-click diagram
   *  - Tap/splice, detail≥2 or forceDiagram → full HTML diagram
   *  - Tap/splice single click → open meet-point glass
   * @returns {boolean} true if consumed
   */
  function handleClick(cssX, cssY, view, ev = {}) {
    if (magnifier.isOpen && magnifier.pointInLens(cssX, cssY, view)) {
      return magnifier.onClick(cssX, cssY, view, {
        altKey: !!ev.altKey,
        detail: ev.detail || 1,
      });
    }

    const p = pick(cssX, cssY, view, lastPickCam, lastPickMppFn);
    if (!p || (p.kind !== "tap" && p.kind !== "splice")) {
      // Click empty map (or non-SP): close glass
      if (magnifier.isOpen && !ev.keepGlass) {
        magnifier.cancel();
        return true;
      }
      return false;
    }

    const forceDiagram =
      !!ev.forceDiagram ||
      !!ev.altKey ||
      (ev.detail || 1) >= 2;

    if (forceDiagram) {
      if (p.sp_guid) return openDiagram(p.sp_guid);
      return false;
    }

    // Single click → meet-point glass at true plant bearings
    return magnifier.open(
      {
        ...p,
        screenCssX: cssX,
        screenCssY: cssY,
      },
      view
    );
  }

  /**
   * Pointer over map: cursor style + inspect chip highlight. Does not open glass.
   * @returns {boolean} true if pointer is over a pickable feature or the lens
   */
  function handlePointerMove(cssX, cssY, view, cam, metersPerPixelFn) {
    if (!show) return false;
    if (magnifier.isOpen) {
      if (magnifier.onPointerMove(cssX, cssY, view)) return true;
      if (magnifier.pointInLens(cssX, cssY, view)) return true;
    }
    const hit = pick(cssX, cssY, view, cam, metersPerPixelFn);
    return !!hit;
  }

  /** @deprecated use handlePointerMove */
  function handleHover(cssX, cssY, view, cam, metersPerPixelFn, dragging) {
    if (dragging) return false;
    return handlePointerMove(cssX, cssY, view, cam, metersPerPixelFn);
  }

  /**
   * Wheel over open magnifier → in-glass zoom (does not zoom the map).
   * @returns {boolean} true if consumed
   */
  function handleWheel(cssX, cssY, view, deltaY) {
    if (!show || !magnifier.isOpen) return false;
    return magnifier.onWheel(cssX, cssY, view, deltaY);
  }

  function cancelGlass() {
    magnifier.cancel();
  }

  /** @deprecated use cancelGlass */
  function cancelHover() {
    magnifier.cancel();
  }

  function openGlass(hit, view) {
    return magnifier.open(hit, view);
  }

  function glassPointerDown(cssX, cssY, view) {
    return magnifier.isOpen && magnifier.onPointerDown(cssX, cssY, view);
  }

  function glassPointerUp(cssX, cssY, view) {
    return magnifier.isOpen && magnifier.onPointerUp(cssX, cssY, view);
  }

  function glassToggleMode() {
    if (!magnifier.isOpen) return false;
    magnifier.toggleMode();
    return true;
  }

  function glassMode() {
    return magnifier.isOpen ? magnifier.mode : null;
  }

  function glassPinchStart(dist, mx, my, view) {
    return magnifier.isOpen && magnifier.onPinchStart(dist, mx, my, view);
  }

  function glassPinchMove(dist, mx, my, view) {
    return magnifier.isOpen && magnifier.onPinchMove(dist, mx, my, view);
  }

  function glassPinchEnd() {
    if (magnifier.isOpen) magnifier.onPinchEnd();
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
    pickNearestSp,
    handleClick,
    handleHover,
    handlePointerMove,
    handleWheel,
    cancelHover,
    cancelGlass,
    openGlass,
    openDiagram,
    glassPointerDown,
    glassPointerUp,
    glassToggleMode,
    glassMode,
    glassPinchStart,
    glassPinchMove,
    glassPinchEnd,
    refreshMemStats,
    getMemReport,
    ensureVisibleTiles,
    get magnifier() {
      return magnifier;
    },
    /** @param {object} view */
    getLensLayout(view) {
      return magnifier.getLensLayout?.(view) ?? null;
    },
    setLayoutService(svc) {
      magnifier.setLayoutService?.(svc);
    },
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
      return fiberCache.size;
    },
    get maxTiles() {
      return fiberCache.maxTiles;
    },
    get evictions() {
      return fiberCache.evictions;
    },
    get manifest() {
      return manifest;
    },
    get magnifierOpen() {
      return magnifier.isOpen;
    },
  };
}
