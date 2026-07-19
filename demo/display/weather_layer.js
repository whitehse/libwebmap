/**
 * Weather / alert package host paint (P4.7 / ADR-022).
 *
 * Loads a weather package JSON (docs/formats/weather-package.md), maps
 * status → webmap_status_rgba colors, and builds WebGPU meshes for
 * Polygon / LineString / Point features. Opacity is host-controlled
 * (slider / ?weather_opacity=). Raster wind fields stay host-only stubs.
 *
 * No C core calls — demo is JS WebGPU host (ADR-014 / ADR-017 Tier C).
 */

const R = 6378137;

/** Match src/webmap.c webmap_status_rgba (0xAABBGGRR). */
export const STATUS_RGBA = {
  unknown: 0xff95a5a6, /* grey */
  ok: 0xff2ecc71, /* green */
  degraded: 0xfff1c40f, /* yellow */
  down: 0xffe74c3c, /* red */
  maint: 0xff3498db, /* blue */
};

const STATUS_FROM_SEVERITY = {
  minor: "ok",
  low: "ok",
  moderate: "degraded",
  medium: "degraded",
  severe: "down",
  extreme: "down",
  high: "down",
};

/** Draw order: above basemap (~0–50), under fiber lines (~80+). */
export const WEATHER_ORDER_FILL = 55;
export const WEATHER_ORDER_LINE = 56;
export const WEATHER_ORDER_POINT = 57;

/**
 * @param {string|URLSearchParams|null} [search]
 * @returns {boolean} false when ?weather=0
 */
export function parseWeatherQuery(search = null) {
  const q =
    search instanceof URLSearchParams
      ? search
      : new URLSearchParams(
          search != null
            ? String(search).replace(/^\?/, "")
            : typeof location !== "undefined"
              ? location.search
              : ""
        );
  const v = q.get("weather");
  if (v == null || v === "") return true;
  if (v === "0" || v === "false" || v === "off" || v === "no") return false;
  return true;
}

/**
 * @param {string|URLSearchParams|null} [search]
 * @returns {number} 0..1 default 0.45
 */
export function parseWeatherOpacityQuery(search = null) {
  const q =
    search instanceof URLSearchParams
      ? search
      : new URLSearchParams(
          search != null
            ? String(search).replace(/^\?/, "")
            : typeof location !== "undefined"
              ? location.search
              : ""
        );
  const raw = q.get("weather_opacity");
  if (raw == null || raw === "") return 0.45;
  const n = Number(raw);
  if (!Number.isFinite(n)) return 0.45;
  return Math.max(0, Math.min(1, n));
}

/**
 * @param {string} [status]
 * @param {string} [severity]
 * @returns {"unknown"|"ok"|"degraded"|"down"|"maint"}
 */
export function resolveWeatherStatus(status, severity) {
  const s = status != null ? String(status).toLowerCase().trim() : "";
  if (s && Object.prototype.hasOwnProperty.call(STATUS_RGBA, s)) return s;
  const sev =
    severity != null ? String(severity).toLowerCase().trim() : "";
  if (sev && STATUS_FROM_SEVERITY[sev]) return STATUS_FROM_SEVERITY[sev];
  return "unknown";
}

/**
 * @param {string} statusKey
 * @param {number} opacity 0..1
 * @returns {number} packed 0xAABBGGRR
 */
export function statusRgba(statusKey, opacity = 1) {
  const base = STATUS_RGBA[statusKey] ?? STATUS_RGBA.unknown;
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255) & 0xff;
  // >>> 0: keep unsigned 32-bit (JS << can sign-extend 0xFF......)
  return ((base & 0x00ffffff) | (a << 24)) >>> 0;
}

/**
 * Validate and normalize package JSON (does not throw on soft fields).
 * @param {unknown} raw
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   package?: object,
 *   features: object[]
 * }}
 */
export function parseWeatherPackage(raw) {
  if (!raw || typeof raw !== "object") {
    return { ok: false, error: "weather package is not an object", features: [] };
  }
  const p = /** @type {Record<string, unknown>} */ (raw);
  if (p.kind != null && p.kind !== "weather") {
    return {
      ok: false,
      error: `expected kind "weather", got ${JSON.stringify(p.kind)}`,
      features: [],
    };
  }
  const features = Array.isArray(p.features) ? p.features : [];
  return {
    ok: true,
    package: p,
    features: features.filter((f) => f && typeof f === "object"),
  };
}

function lonLatToMerc(lon, lat) {
  const x = (R * lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
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
  if (scale > 2.5) scale = 2.5;
  return [mx * scale, my * scale];
}

/** Ring as lon/lat pairs → mercator Float32Array (interleaved). */
function ringToMerc(ring) {
  if (!Array.isArray(ring) || ring.length < 2) return null;
  const out = new Float32Array(ring.length * 2);
  let n = 0;
  for (let i = 0; i < ring.length; i++) {
    const c = ring[i];
    if (!Array.isArray(c) || c.length < 2) continue;
    const lon = Number(c[0]);
    const lat = Number(c[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const [mx, my] = lonLatToMerc(lon, lat);
    out[n * 2] = mx;
    out[n * 2 + 1] = my;
    n++;
  }
  if (n < 2) return null;
  return out.subarray(0, n * 2);
}

/**
 * Ear-clip a simple polygon (no holes). ring: interleaved mercator, may
 * close with duplicate last==first.
 * @returns {{verts: Float32Array, indices: Uint32Array}|null}
 */
function triangulateRing(ring) {
  if (!ring || ring.length < 6) return null;
  let n = ring.length / 2;
  // Drop closing duplicate
  if (
    n >= 4 &&
    Math.abs(ring[0] - ring[(n - 1) * 2]) < 1e-6 &&
    Math.abs(ring[1] - ring[(n - 1) * 2 + 1]) < 1e-6
  ) {
    n -= 1;
  }
  if (n < 3) return null;

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = ring[i * 2];
    ys[i] = ring[i * 2 + 1];
  }

  // Signed area (positive = CCW in screen y-up mercator)
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += xs[i] * ys[j] - xs[j] * ys[i];
  }
  const idx = [];
  for (let i = 0; i < n; i++) idx.push(i);
  if (area < 0) idx.reverse();

  const verts = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    verts[i * 2] = xs[i];
    verts[i * 2 + 1] = ys[i];
  }

  const triangles = [];
  const rest = idx.slice();
  let guard = 0;
  const maxIter = n * n + 8;

  function isEar(i0, i1, i2) {
    const ax = xs[i0],
      ay = ys[i0];
    const bx = xs[i1],
      by = ys[i1];
    const cx = xs[i2],
      cy = ys[i2];
    // Convex (CCW)
    const cross = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (cross <= 1e-12) return false;
    for (let k = 0; k < rest.length; k++) {
      const p = rest[k];
      if (p === i0 || p === i1 || p === i2) continue;
      if (pointInTri(xs[p], ys[p], ax, ay, bx, by, cx, cy)) return false;
    }
    return true;
  }

  function pointInTri(px, py, ax, ay, bx, by, cx, cy) {
    const d1 = (px - ax) * (by - ay) - (py - ay) * (bx - ax);
    const d2 = (px - bx) * (cy - by) - (py - by) * (cx - bx);
    const d3 = (px - cx) * (ay - cy) - (py - cy) * (ax - cx);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
  }

  while (rest.length > 3 && guard++ < maxIter) {
    let clipped = false;
    for (let i = 0; i < rest.length; i++) {
      const i0 = rest[(i + rest.length - 1) % rest.length];
      const i1 = rest[i];
      const i2 = rest[(i + 1) % rest.length];
      if (!isEar(i0, i1, i2)) continue;
      triangles.push(i0, i1, i2);
      rest.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Degenerate / self-intersecting — fan fallback
      const a = rest[0];
      for (let i = 1; i < rest.length - 1; i++) {
        triangles.push(a, rest[i], rest[i + 1]);
      }
      rest.length = 0;
      break;
    }
  }
  if (rest.length === 3) {
    triangles.push(rest[0], rest[1], rest[2]);
  }
  if (triangles.length < 3) return null;
  return { verts, indices: new Uint32Array(triangles) };
}

/**
 * Extrude open polyline to triangle strip indices (shader half-width).
 * @param {Float32Array} pts interleaved mercator
 * @param {number} rgba
 */
function extrudeLine(pts, rgba) {
  const n = pts.length / 2;
  if (n < 2) return null;
  const out = new ArrayBuffer(n * 2 * 24);
  const dv = new DataView(out);
  const inds = new Uint32Array((n - 1) * 6);
  let vi = 0;
  let ii = 0;
  for (let i = 0; i < n; i++) {
    const x = pts[i * 2];
    const y = pts[i * 2 + 1];
    const [nx, ny] = joinNormal(pts, i, n);
    writeVertex(dv, vi++, x, y, nx, ny, rgba);
    writeVertex(dv, vi++, x, y, -nx, -ny, rgba);
  }
  for (let i = 0; i < n - 1; i++) {
    const a = i * 2;
    const b = (i + 1) * 2;
    inds[ii++] = a;
    inds[ii++] = a + 1;
    inds[ii++] = b;
    inds[ii++] = a + 1;
    inds[ii++] = b + 1;
    inds[ii++] = b;
  }
  return {
    buffer: out,
    indices: inds,
    vertexCount: vi,
    indexCount: ii,
  };
}

/** Axis-aligned diamond/quad around point for POINT features. */
function pointQuad(mx, my, halfM, rgba) {
  const out = new ArrayBuffer(4 * 24);
  const dv = new DataView(out);
  // Square in mercator meters (halfM on each axis)
  writeVertex(dv, 0, mx - halfM, my - halfM, 0, 0, rgba);
  writeVertex(dv, 1, mx + halfM, my - halfM, 0, 0, rgba);
  writeVertex(dv, 2, mx + halfM, my + halfM, 0, 0, rgba);
  writeVertex(dv, 3, mx - halfM, my + halfM, 0, 0, rgba);
  return {
    buffer: out,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    vertexCount: 4,
    indexCount: 6,
  };
}

/**
 * @param {{
 *   device: GPUDevice,
 *   log?: (s: string) => void,
 *   memStats?: { addGpu?: Function, subGpu?: Function } | null,
 *   opacity?: number,
 *   enabled?: boolean,
 * }} opts
 */
export function createWeatherLayer(opts) {
  const { device, log = () => {}, memStats = null } = opts;
  let opacity =
    opts.opacity != null && Number.isFinite(opts.opacity)
      ? Math.max(0, Math.min(1, opts.opacity))
      : 0.45;
  let enabled = opts.enabled !== false;
  /** @type {object[]} */
  let meshes = [];
  /** @type {object[]} raw features for rebuild on opacity change */
  let features = [];
  /** @type {object|null} */
  let pkgMeta = null;
  let gpuBytes = 0;

  function destroyMeshes() {
    for (let i = 0; i < meshes.length; i++) {
      const m = meshes[i];
      try {
        m.vb?.destroy?.();
        m.ib?.destroy?.();
      } catch {
        /* */
      }
    }
    if (gpuBytes && memStats?.subGpu) {
      memStats.subGpu("weather_gpu", gpuBytes);
    }
    meshes = [];
    gpuBytes = 0;
  }

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
    const bytes = vbSize + ibSize;
    gpuBytes += bytes;
    return { vb, ib, indexCount, _gpuBytes: bytes, ...meta };
  }

  function buildFeatureMeshes(feature) {
    const id = feature.id != null ? String(feature.id) : "weather";
    const status = resolveWeatherStatus(
      feature.status,
      feature.props?.severity
    );
    const rgba = statusRgba(status, opacity);
    const geom = feature.geom;
    if (!geom || typeof geom !== "object") return [];
    const type = String(geom.type || "");
    const coords = geom.coordinates;
    /** @type {object[]} */
    const out = [];

    if (type === "Polygon" && Array.isArray(coords)) {
      // Exterior only in v1 (holes ignored)
      const merc = ringToMerc(coords[0]);
      const tri = triangulateRing(merc);
      if (tri) {
        const n = tri.verts.length / 2;
        const buf = new ArrayBuffer(n * 24);
        const dv = new DataView(buf);
        for (let i = 0; i < n; i++) {
          writeVertex(
            dv,
            i,
            tri.verts[i * 2],
            tri.verts[i * 2 + 1],
            0,
            0,
            rgba
          );
        }
        out.push(
          createMesh(buf, tri.indices, tri.indices.length, {
            name: `weather/${id}`,
            kind: "weather-fill",
            order: WEATHER_ORDER_FILL,
            weatherId: id,
            status,
            halfWidthPx: 0,
          })
        );
      }
    } else if (type === "MultiPolygon" && Array.isArray(coords)) {
      for (let p = 0; p < coords.length; p++) {
        const poly = coords[p];
        if (!Array.isArray(poly)) continue;
        const merc = ringToMerc(poly[0]);
        const tri = triangulateRing(merc);
        if (!tri) continue;
        const n = tri.verts.length / 2;
        const buf = new ArrayBuffer(n * 24);
        const dv = new DataView(buf);
        for (let i = 0; i < n; i++) {
          writeVertex(
            dv,
            i,
            tri.verts[i * 2],
            tri.verts[i * 2 + 1],
            0,
            0,
            rgba
          );
        }
        out.push(
          createMesh(buf, tri.indices, tri.indices.length, {
            name: `weather/${id}/${p}`,
            kind: "weather-fill",
            order: WEATHER_ORDER_FILL,
            weatherId: id,
            status,
            halfWidthPx: 0,
          })
        );
      }
    } else if (type === "LineString" && Array.isArray(coords)) {
      const merc = ringToMerc(coords);
      const ext = extrudeLine(merc, rgba);
      if (ext) {
        out.push(
          createMesh(ext.buffer, ext.indices, ext.indexCount, {
            name: `weather/${id}`,
            kind: "weather-line",
            order: WEATHER_ORDER_LINE,
            weatherId: id,
            status,
            halfWidthPx: 3,
          })
        );
      }
    } else if (type === "MultiLineString" && Array.isArray(coords)) {
      for (let li = 0; li < coords.length; li++) {
        const merc = ringToMerc(coords[li]);
        const ext = extrudeLine(merc, rgba);
        if (!ext) continue;
        out.push(
          createMesh(ext.buffer, ext.indices, ext.indexCount, {
            name: `weather/${id}/${li}`,
            kind: "weather-line",
            order: WEATHER_ORDER_LINE,
            weatherId: id,
            status,
            halfWidthPx: 3,
          })
        );
      }
    } else if (type === "Point" && Array.isArray(coords) && coords.length >= 2) {
      const lon = Number(coords[0]);
      const lat = Number(coords[1]);
      if (Number.isFinite(lon) && Number.isFinite(lat)) {
        const [mx, my] = lonLatToMerc(lon, lat);
        // ~120 m diamond; fixed world size so points stay visible at z10
        const q = pointQuad(mx, my, 120, rgba);
        out.push(
          createMesh(q.buffer, q.indices, q.indexCount, {
            name: `weather/${id}`,
            kind: "weather-point",
            order: WEATHER_ORDER_POINT,
            weatherId: id,
            status,
            halfWidthPx: 0,
          })
        );
      }
    } else if (type === "MultiPoint" && Array.isArray(coords)) {
      for (let pi = 0; pi < coords.length; pi++) {
        const c = coords[pi];
        if (!Array.isArray(c) || c.length < 2) continue;
        const lon = Number(c[0]);
        const lat = Number(c[1]);
        if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
        const [mx, my] = lonLatToMerc(lon, lat);
        const q = pointQuad(mx, my, 120, rgba);
        out.push(
          createMesh(q.buffer, q.indices, q.indexCount, {
            name: `weather/${id}/${pi}`,
            kind: "weather-point",
            order: WEATHER_ORDER_POINT,
            weatherId: id,
            status,
            halfWidthPx: 0,
          })
        );
      }
    }
    return out;
  }

  function rebuild() {
    destroyMeshes();
    if (!enabled || opacity <= 0) {
      if (memStats?.addGpu) memStats.addGpu("weather_gpu", 0);
      return;
    }
    for (let i = 0; i < features.length; i++) {
      const built = buildFeatureMeshes(features[i]);
      for (let j = 0; j < built.length; j++) meshes.push(built[j]);
    }
    if (memStats?.addGpu && gpuBytes) memStats.addGpu("weather_gpu", gpuBytes);
  }

  /**
   * @param {string} url
   * @returns {Promise<{featureCount: number, meshCount: number}|null>}
   */
  async function load(url) {
    const res = await fetch(url);
    if (!res.ok) {
      log(`weather: ${url} → HTTP ${res.status}`);
      return null;
    }
    let raw;
    try {
      raw = await res.json();
    } catch (e) {
      log(`weather: bad JSON ${url}: ${e.message}`);
      return null;
    }
    const parsed = parseWeatherPackage(raw);
    if (!parsed.ok) {
      log(`weather: ${parsed.error}`);
      return null;
    }
    pkgMeta = parsed.package;
    features = parsed.features;
    rebuild();
    const label =
      pkgMeta?.source?.label ||
      pkgMeta?.name ||
      "weather package";
    log(
      `weather: ${label} · ${features.length} features · ${meshes.length} meshes · opacity ${opacity.toFixed(2)}`
    );
    if (pkgMeta?.raster) {
      log(
        "weather: raster stub present (host texture not painted in v1)"
      );
    }
    return { featureCount: features.length, meshCount: meshes.length };
  }

  /**
   * Push draw descriptors into the shared basemap/fiber draw list.
   * @param {object[]} draws
   */
  function collectDraws(draws) {
    if (!enabled || opacity <= 0) return;
    for (let i = 0; i < meshes.length; i++) draws.push(meshes[i]);
  }

  /**
   * @param {object} g
   * @param {{zoom:number}} cam
   * @param {number} mpp meters per pixel
   * @returns {number|null}
   */
  function halfWidthForDraw(g, cam, mpp) {
    if (g?.kind === "weather-line") {
      const px = g.halfWidthPx ?? 3;
      return px * 0.5 * mpp;
    }
    return null;
  }

  function setOpacity(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const next = Math.max(0, Math.min(1, n));
    if (Math.abs(next - opacity) < 1e-4) return;
    opacity = next;
    rebuild();
  }

  function setEnabled(v) {
    const next = !!v;
    if (next === enabled) return;
    enabled = next;
    rebuild();
  }

  function getMemReport() {
    return {
      gpu_bytes: gpuBytes,
      mesh_count: meshes.length,
      feature_count: features.length,
      opacity,
      enabled,
    };
  }

  function destroy() {
    destroyMeshes();
    features = [];
    pkgMeta = null;
  }

  return {
    load,
    collectDraws,
    halfWidthForDraw,
    setOpacity,
    setEnabled,
    getMemReport,
    destroy,
    get opacity() {
      return opacity;
    },
    get enabled() {
      return enabled;
    },
    get featureCount() {
      return features.length;
    },
    get meshCount() {
      return meshes.length;
    },
    get packageMeta() {
      return pkgMeta;
    },
  };
}
