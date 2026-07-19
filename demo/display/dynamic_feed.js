/**
 * Dynamic map.dynamic feed consumer (P4.9 / ADR-023).
 *
 * Offline path: fixture JSONL (NOTIFY-shaped events).
 * Online path: optional WebSocket (`?feed=ws://…`) matching edgehost
 * STATE_CHANGED envelopes — does **not** require edgehost to run the demo.
 *
 * Host-only (ADR-014 / ADR-017). No Postgres inside WASM/C core.
 */

import { GLASS_STATUS } from "./glass_tokens.js";

const R = 6378137;

/** Default max payload (program design notify_max_payload). */
export const NOTIFY_MAX_PAYLOAD = 8000;

/** v1 allowlisted namespaces for map paint + store. */
export const ALLOWED_NS = Object.freeze(["map.dynamic"]);

/** Draw order: above weather (~55–57), under fiber (~80+). */
export const DYNAMIC_ORDER_FILL = 60;
export const DYNAMIC_ORDER_LINE = 61;
export const DYNAMIC_ORDER_POINT = 62;

const OPS_UPSERT = new Set(["upsert", "put", "update"]);
const OPS_REMOVE = new Set(["remove", "delete", "del"]);

/**
 * @param {string|URLSearchParams|null} [search]
 * @returns {{
 *   enabled: boolean,
 *   mode: "off"|"fixture"|"ws",
 *   url: string,
 *   intervalMs: number,
 * }}
 */
export function parseFeedQuery(search = null) {
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
  const raw = q.get("feed");
  let intervalMs = 900;
  const iv = q.get("feed_interval");
  if (iv != null && iv !== "") {
    const n = Number(iv);
    if (Number.isFinite(n) && n >= 0) intervalMs = Math.floor(n);
  }

  if (raw == null || raw === "") {
    return {
      enabled: true,
      mode: "fixture",
      url: "./dynamic/sample_events.jsonl",
      intervalMs,
    };
  }
  const v = String(raw).trim();
  if (v === "0" || v === "false" || v === "off" || v === "no") {
    return { enabled: false, mode: "off", url: "", intervalMs };
  }
  if (/^wss?:\/\//i.test(v)) {
    return { enabled: true, mode: "ws", url: v, intervalMs };
  }
  // Relative or absolute HTTP(S) path to JSONL
  return { enabled: true, mode: "fixture", url: v, intervalMs };
}

/**
 * Normalize raw text/object into a NOTIFY or STATE_CHANGED message.
 * @param {string|object} raw
 * @param {{ maxPayload?: number }} [opts]
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   metric?: string,
 *   msg?: {
 *     v: number,
 *     op: string,
 *     ns: string,
 *     key: string,
 *     value: object|null,
 *     source: "notify"|"state_changed"|"fixture",
 *     request_id?: string,
 *   }
 * }}
 */
export function parseDynamicMessage(raw, opts = {}) {
  const maxPayload = opts.maxPayload ?? NOTIFY_MAX_PAYLOAD;
  let text;
  let obj;

  if (typeof raw === "string") {
    text = raw.trim();
    if (!text) {
      return { ok: false, reason: "empty", metric: "notify_bad_payload" };
    }
    if (text.length > maxPayload) {
      return { ok: false, reason: "too_large", metric: "notify_bad_payload" };
    }
    try {
      obj = JSON.parse(text);
    } catch {
      return { ok: false, reason: "json", metric: "notify_bad_payload" };
    }
  } else if (raw && typeof raw === "object") {
    obj = raw;
    try {
      text = JSON.stringify(raw);
    } catch {
      return { ok: false, reason: "json", metric: "notify_bad_payload" };
    }
    if (text.length > maxPayload) {
      return { ok: false, reason: "too_large", metric: "notify_bad_payload" };
    }
  } else {
    return { ok: false, reason: "empty", metric: "notify_bad_payload" };
  }

  if (!obj || typeof obj !== "object") {
    return { ok: false, reason: "json", metric: "notify_bad_payload" };
  }

  // Edgehost WS envelope
  if (obj.type === "STATE_CHANGED") {
    const ns = String(obj.ns || "");
    const key = String(obj.key || "");
    let op = String(obj.op || "put").toLowerCase();
    if (op === "put") op = "upsert";
    if (op === "delete") op = "remove";
    if (obj.v != null && Number(obj.v) !== 1) {
      return { ok: false, reason: "version", metric: "notify_bad_payload" };
    }
    if (!ALLOWED_NS.includes(ns)) {
      return { ok: false, reason: "ns", metric: "notify_ns_drop" };
    }
    if (!key || key.length > 256) {
      return { ok: false, reason: "key", metric: "notify_bad_payload" };
    }
    if (OPS_REMOVE.has(op)) {
      return {
        ok: true,
        msg: {
          v: 1,
          op: "remove",
          ns,
          key,
          value: null,
          source: "state_changed",
          request_id: obj.request_id != null ? String(obj.request_id) : undefined,
        },
      };
    }
    if (!OPS_UPSERT.has(op)) {
      return { ok: false, reason: "op", metric: "notify_bad_payload" };
    }
    if (!obj.value || typeof obj.value !== "object") {
      return { ok: false, reason: "value", metric: "notify_bad_payload" };
    }
    return {
      ok: true,
      msg: {
        v: 1,
        op: "upsert",
        ns,
        key,
        value: obj.value,
        source: "state_changed",
        request_id: obj.request_id != null ? String(obj.request_id) : undefined,
      },
    };
  }

  // NOTIFY-shaped / fixture line
  const v = obj.v != null ? Number(obj.v) : 1;
  if (v !== 1) {
    return { ok: false, reason: "version", metric: "notify_bad_payload" };
  }
  const ns = String(obj.ns || "");
  const key = String(obj.key || "");
  let op = String(obj.op || "upsert").toLowerCase();
  if (op === "put" || op === "update") op = "upsert";
  if (op === "delete" || op === "del") op = "remove";

  if (!ALLOWED_NS.includes(ns)) {
    return { ok: false, reason: "ns", metric: "notify_ns_drop" };
  }
  if (!key || key.length > 256) {
    return { ok: false, reason: "key", metric: "notify_bad_payload" };
  }
  if (OPS_REMOVE.has(op)) {
    return {
      ok: true,
      msg: {
        v: 1,
        op: "remove",
        ns,
        key,
        value: null,
        source: "notify",
      },
    };
  }
  if (!OPS_UPSERT.has(op)) {
    return { ok: false, reason: "op", metric: "notify_bad_payload" };
  }
  if (!obj.value || typeof obj.value !== "object") {
    return { ok: false, reason: "value", metric: "notify_bad_payload" };
  }
  return {
    ok: true,
    msg: {
      v: 1,
      op: "upsert",
      ns,
      key,
      value: obj.value,
      source: "notify",
    },
  };
}

/**
 * Parse JSONL text into { line, result } entries (does not apply).
 * @param {string} text
 */
export function parseJsonlEvents(text) {
  const lines = String(text || "").split(/\r?\n/);
  /** @type {{line: number, raw: string, result: ReturnType<typeof parseDynamicMessage>}[]} */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith("#")) continue;
    out.push({ line: i + 1, raw, result: parseDynamicMessage(raw) });
  }
  return out;
}

function resolveStatus(status) {
  const s = status != null ? String(status).toLowerCase().trim() : "";
  if (s && GLASS_STATUS[s]) return s;
  return "unknown";
}

function statusRgba(statusKey, opacity = 0.85) {
  const st = GLASS_STATUS[statusKey] || GLASS_STATUS.unknown;
  const a = Math.round(Math.max(0, Math.min(1, opacity)) * 255) & 0xff;
  return ((st.rgba & 0x00ffffff) | (a << 24)) >>> 0;
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

function triangulateRing(ring) {
  if (!ring || ring.length < 6) return null;
  let n = ring.length / 2;
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
  // Fan triangulation (v1; fixtures use simple convex rings)
  const triangles = [];
  const a = idx[0];
  for (let i = 1; i < idx.length - 1; i++) {
    triangles.push(a, idx[i], idx[i + 1]);
  }
  if (triangles.length < 3) return null;
  return { verts, indices: new Uint32Array(triangles) };
}

function extrudeLine(pts, rgba) {
  const n = pts.length / 2;
  if (n < 2) return null;
  const out = new ArrayBuffer(n * 2 * 24);
  const dv = new DataView(out);
  const inds = new Uint32Array((n - 1) * 6);
  let vi = 0;
  let ii = 0;
  for (let i = 0; i < n; i++) {
    const [nx, ny] = joinNormal(pts, i, n);
    writeVertex(dv, vi++, pts[i * 2], pts[i * 2 + 1], nx, ny, rgba);
    writeVertex(dv, vi++, pts[i * 2], pts[i * 2 + 1], -nx, -ny, rgba);
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
  return { buffer: out, indices: inds, indexCount: ii };
}

function pointQuad(mx, my, halfM, rgba) {
  const out = new ArrayBuffer(4 * 24);
  const dv = new DataView(out);
  writeVertex(dv, 0, mx - halfM, my - halfM, 0, 0, rgba);
  writeVertex(dv, 1, mx + halfM, my - halfM, 0, 0, rgba);
  writeVertex(dv, 2, mx + halfM, my + halfM, 0, 0, rgba);
  writeVertex(dv, 3, mx - halfM, my + halfM, 0, 0, rgba);
  return {
    buffer: out,
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    indexCount: 6,
  };
}

/**
 * @param {{
 *   device?: GPUDevice|null,
 *   log?: (s: string) => void,
 *   memStats?: { addGpu?: Function, subGpu?: Function } | null,
 *   onChange?: (store: Map<string, object>) => void,
 *   maxPayload?: number,
 *   opacity?: number,
 * }} opts
 */
export function createDynamicFeed(opts = {}) {
  const log = opts.log || (() => {});
  const memStats = opts.memStats || null;
  const onChange = opts.onChange || (() => {});
  const maxPayload = opts.maxPayload ?? NOTIFY_MAX_PAYLOAD;
  let opacity =
    opts.opacity != null && Number.isFinite(opts.opacity)
      ? Math.max(0, Math.min(1, opts.opacity))
      : 0.85;
  /** @type {GPUDevice|null} */
  let device = opts.device || null;

  /** @type {Map<string, {ns: string, key: string, value: object, updated_at?: string}>} */
  const store = new Map();
  /** @type {object[]} */
  let meshes = [];
  let gpuBytes = 0;
  const metrics = {
    applied: 0,
    removed: 0,
    bad_payload: 0,
    ns_drop: 0,
    ws_messages: 0,
    fixture_lines: 0,
  };
  /** @type {Array<{t: number, op: string, key: string, status?: string}>} */
  let recent = [];
  let enabled = true;
  /** @type {WebSocket|null} */
  let ws = null;
  /** @type {ReturnType<typeof setTimeout>|null} */
  let fixtureTimer = null;
  let mode = "off";
  let sourceUrl = "";

  function storeKey(ns, key) {
    return `${ns}\0${key}`;
  }

  function destroyMeshes() {
    for (let i = 0; i < meshes.length; i++) {
      try {
        meshes[i].vb?.destroy?.();
        meshes[i].ib?.destroy?.();
      } catch {
        /* */
      }
    }
    if (gpuBytes && memStats?.subGpu) memStats.subGpu("dynamic_gpu", gpuBytes);
    meshes = [];
    gpuBytes = 0;
  }

  function createMesh(vertBuf, indices, indexCount, meta) {
    if (!device) return null;
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

  function buildMeshesForEntry(entry) {
    if (!device || !entry?.value) return [];
    const val = entry.value;
    const id = val.id != null ? String(val.id) : entry.key;
    const status = resolveStatus(val.status);
    const rgba = statusRgba(status, opacity);
    const geom = val.geom;
    /** @type {object[]} */
    const out = [];

    if (geom && typeof geom === "object") {
      const type = String(geom.type || "");
      const coords = geom.coordinates;
      if (type === "Polygon" && Array.isArray(coords)) {
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
          const m = createMesh(buf, tri.indices, tri.indices.length, {
            name: `dyn/${id}`,
            kind: "dynamic-fill",
            order: DYNAMIC_ORDER_FILL,
            status,
            halfWidthPx: 0,
          });
          if (m) out.push(m);
        }
      } else if (type === "LineString" && Array.isArray(coords)) {
        const merc = ringToMerc(coords);
        const ext = extrudeLine(merc, rgba);
        if (ext) {
          const m = createMesh(ext.buffer, ext.indices, ext.indexCount, {
            name: `dyn/${id}`,
            kind: "dynamic-line",
            order: DYNAMIC_ORDER_LINE,
            status,
            halfWidthPx: 4,
          });
          if (m) out.push(m);
        }
      } else if (
        type === "Point" &&
        Array.isArray(coords) &&
        coords.length >= 2
      ) {
        const lon = Number(coords[0]);
        const lat = Number(coords[1]);
        if (Number.isFinite(lon) && Number.isFinite(lat)) {
          const [mx, my] = lonLatToMerc(lon, lat);
          const q = pointQuad(mx, my, 140, rgba);
          const m = createMesh(q.buffer, q.indices, q.indexCount, {
            name: `dyn/${id}`,
            kind: "dynamic-point",
            order: DYNAMIC_ORDER_POINT,
            status,
            halfWidthPx: 0,
          });
          if (m) out.push(m);
        }
      }
    } else if (
      Number.isFinite(Number(val.lon)) &&
      Number.isFinite(Number(val.lat))
    ) {
      const [mx, my] = lonLatToMerc(Number(val.lon), Number(val.lat));
      const q = pointQuad(mx, my, 140, rgba);
      const m = createMesh(q.buffer, q.indices, q.indexCount, {
        name: `dyn/${id}`,
        kind: "dynamic-point",
        order: DYNAMIC_ORDER_POINT,
        status,
        halfWidthPx: 0,
      });
      if (m) out.push(m);
    }
    // geom_ref without inline geom: store-only (HUD); weather layer owns paint
    return out;
  }

  function rebuildMeshes() {
    destroyMeshes();
    if (!enabled || !device) return;
    for (const entry of store.values()) {
      const built = buildMeshesForEntry(entry);
      for (let i = 0; i < built.length; i++) meshes.push(built[i]);
    }
    if (memStats?.addGpu && gpuBytes) memStats.addGpu("dynamic_gpu", gpuBytes);
  }

  function pushRecent(op, key, status) {
    recent.unshift({
      t: Date.now(),
      op,
      key,
      status,
    });
    if (recent.length > 24) recent.length = 24;
  }

  /**
   * Apply one validated or raw message.
   * @param {string|object} raw
   * @returns {{ok: boolean, reason?: string}}
   */
  function applyMessage(raw) {
    const r = parseDynamicMessage(raw, { maxPayload });
    if (!r.ok) {
      if (r.metric === "notify_ns_drop") metrics.ns_drop++;
      else metrics.bad_payload++;
      return { ok: false, reason: r.reason };
    }
    const msg = r.msg;
    const sk = storeKey(msg.ns, msg.key);
    if (msg.op === "remove") {
      if (store.delete(sk)) {
        metrics.removed++;
        pushRecent("remove", msg.key);
        rebuildMeshes();
        onChange(store);
        refreshHud();
      }
      return { ok: true };
    }
    const val = { ...msg.value };
    if (!val.updated_at) val.updated_at = new Date().toISOString();
    store.set(sk, {
      ns: msg.ns,
      key: msg.key,
      value: val,
      updated_at: val.updated_at,
    });
    metrics.applied++;
    pushRecent("upsert", msg.key, resolveStatus(val.status));
    rebuildMeshes();
    onChange(store);
    refreshHud();
    return { ok: true };
  }

  function refreshHud() {
    const el = typeof document !== "undefined"
      ? document.getElementById("dynamic-feed-hud")
      : null;
    if (!el) return;
    const rows = [];
    rows.push(
      `<div class="mem-title">Dynamic feed <span class="mem-muted">(${mode})</span></div>`
    );
    rows.push(
      `<div class="mem-row"><span>keys</span><code>${store.size}</code></div>`
    );
    rows.push(
      `<div class="mem-row"><span>meshes</span><code>${meshes.length}</code></div>`
    );
    rows.push(
      `<div class="mem-row"><span>applied / drop</span><code>${metrics.applied} / ${metrics.bad_payload + metrics.ns_drop}</code></div>`
    );
    if (sourceUrl) {
      rows.push(
        `<div class="mem-muted" style="margin:0.25rem 0;word-break:break-all">${escapeHtml(sourceUrl)}</div>`
      );
    }
    if (recent.length) {
      rows.push(`<div class="mem-muted" style="margin-top:0.35rem">Recent</div>`);
      for (let i = 0; i < Math.min(6, recent.length); i++) {
        const e = recent[i];
        const st = e.status || "—";
        const cls =
          st === "down"
            ? "err"
            : st === "degraded"
              ? "warn"
              : st === "ok"
                ? "ok"
                : "";
        rows.push(
          `<div class="mem-row"><span class="${cls}">${escapeHtml(e.op)}</span><code title="${escapeHtml(e.key)}">${escapeHtml(shortKey(e.key))}${e.status ? " · " + escapeHtml(e.status) : ""}</code></div>`
        );
      }
    }
    el.innerHTML = rows.join("");
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function shortKey(k) {
    const s = String(k);
    if (s.length <= 28) return s;
    return s.slice(0, 12) + "…" + s.slice(-12);
  }

  /**
   * Load and play JSONL fixture with optional inter-event delay.
   * @param {string} url
   * @param {{ intervalMs?: number }} [play]
   */
  async function loadFixture(url, play = {}) {
    mode = "fixture";
    sourceUrl = url;
    const intervalMs =
      play.intervalMs != null && Number.isFinite(play.intervalMs)
        ? Math.max(0, play.intervalMs)
        : 0;
    const res = await fetch(url);
    if (!res.ok) {
      log(`dynamic feed: ${url} → HTTP ${res.status}`);
      refreshHud();
      return { ok: false, count: 0 };
    }
    const text = await res.text();
    const entries = parseJsonlEvents(text);
    metrics.fixture_lines = entries.length;
    log(
      `dynamic feed: fixture ${url} · ${entries.length} lines · interval ${intervalMs}ms`
    );

    if (fixtureTimer != null) {
      clearTimeout(fixtureTimer);
      fixtureTimer = null;
    }

    let i = 0;
    const step = () => {
      while (i < entries.length) {
        const e = entries[i++];
        if (!e.result.ok) {
          if (e.result.metric === "notify_ns_drop") metrics.ns_drop++;
          else metrics.bad_payload++;
          log(
            `dynamic feed: drop line ${e.line} (${e.result.reason || "bad"})`
          );
          continue;
        }
        applyMessage(e.result.msg);
        if (intervalMs > 0 && i < entries.length) {
          fixtureTimer = setTimeout(step, intervalMs);
          return;
        }
      }
      fixtureTimer = null;
      log(
        `dynamic feed: playback done · store ${store.size} · meshes ${meshes.length}`
      );
      refreshHud();
    };

    if (intervalMs > 0) {
      // Apply first event immediately, then pace the rest
      step();
    } else {
      for (const e of entries) {
        if (!e.result.ok) {
          if (e.result.metric === "notify_ns_drop") metrics.ns_drop++;
          else metrics.bad_payload++;
          continue;
        }
        applyMessage(e.result.msg);
      }
      log(
        `dynamic feed: applied ${metrics.applied} · store ${store.size} · meshes ${meshes.length}`
      );
    }
    refreshHud();
    return { ok: true, count: entries.length };
  }

  /**
   * Connect WebSocket for STATE_CHANGED / NOTIFY-shaped JSON messages.
   * @param {string} url
   */
  function connectWs(url) {
    mode = "ws";
    sourceUrl = url;
    if (typeof WebSocket === "undefined") {
      log("dynamic feed: WebSocket not available");
      return;
    }
    stop();
    enabled = true;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      log("dynamic feed: WS open failed: " + (e.message || e));
      refreshHud();
      return;
    }
    ws.onopen = () => {
      log(`dynamic feed: WS connected ${url}`);
      refreshHud();
    };
    ws.onmessage = (ev) => {
      metrics.ws_messages++;
      const data = typeof ev.data === "string" ? ev.data : String(ev.data);
      const r = applyMessage(data);
      if (!r.ok) {
        log(`dynamic feed: WS drop (${r.reason || "bad"})`);
      }
    };
    ws.onerror = () => {
      log("dynamic feed: WS error");
    };
    ws.onclose = () => {
      log("dynamic feed: WS closed");
      ws = null;
      refreshHud();
    };
    refreshHud();
  }

  function stop() {
    if (fixtureTimer != null) {
      clearTimeout(fixtureTimer);
      fixtureTimer = null;
    }
    if (ws) {
      try {
        ws.close();
      } catch {
        /* */
      }
      ws = null;
    }
  }

  /**
   * Start from parseFeedQuery result.
   * @param {ReturnType<typeof parseFeedQuery>} cfg
   */
  async function start(cfg) {
    stop();
    if (!cfg || !cfg.enabled || cfg.mode === "off") {
      enabled = false;
      mode = "off";
      sourceUrl = "";
      log("dynamic feed: off (?feed=0)");
      refreshHud();
      return;
    }
    enabled = true;
    if (cfg.mode === "ws") {
      connectWs(cfg.url);
      return;
    }
    await loadFixture(cfg.url, { intervalMs: cfg.intervalMs });
  }

  function collectDraws(draws) {
    if (!enabled) return;
    for (let i = 0; i < meshes.length; i++) draws.push(meshes[i]);
  }

  function halfWidthForDraw(g, cam, mpp) {
    if (g?.kind === "dynamic-line") {
      const px = g.halfWidthPx ?? 4;
      return px * 0.5 * mpp;
    }
    return null;
  }

  function setDevice(dev) {
    device = dev || null;
    rebuildMeshes();
  }

  function setEnabled(v) {
    enabled = !!v;
    if (!enabled) destroyMeshes();
    else rebuildMeshes();
    refreshHud();
  }

  function getMemReport() {
    return {
      gpu_bytes: gpuBytes,
      mesh_count: meshes.length,
      key_count: store.size,
      metrics: { ...metrics },
      mode,
    };
  }

  function listEntries() {
    return Array.from(store.values()).map((e) => ({
      ns: e.ns,
      key: e.key,
      value: e.value,
    }));
  }

  function destroy() {
    stop();
    destroyMeshes();
    store.clear();
  }

  return {
    start,
    stop,
    loadFixture,
    connectWs,
    applyMessage,
    collectDraws,
    halfWidthForDraw,
    setDevice,
    setEnabled,
    getMemReport,
    listEntries,
    refreshHud,
    destroy,
    get store() {
      return store;
    },
    get metrics() {
      return metrics;
    },
    get mode() {
      return mode;
    },
    get enabled() {
      return enabled;
    },
    get meshCount() {
      return meshes.length;
    },
    get size() {
      return store.size;
    },
  };
}
