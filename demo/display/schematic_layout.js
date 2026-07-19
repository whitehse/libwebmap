/**
 * Decode webmap_schematic_layout binary blob (P4.10 / ADR-020)
 * and host service for magnifier consumption (P4.11).
 *
 * Interaction stays JS; pure geometry prefers WASM when available.
 */

export const SCHEMATIC_MAGIC = 0x48435357; /* WSCH le */
export const SCHEMATIC_VERSION = 1;

/**
 * @param {string|URLSearchParams|null} [search]
 * @returns {"auto"|"wasm"|"js"}
 */
export function parseSchematicQuery(search = null) {
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
  const v = (q.get("schematic") || q.get("layout") || "auto")
    .toLowerCase()
    .trim();
  if (v === "js" || v === "0" || v === "false" || v === "off") return "js";
  if (v === "wasm" || v === "1" || v === "true" || v === "on") return "wasm";
  return "auto";
}

/**
 * @param {ArrayBuffer|Uint8Array} buf
 * @returns {{
 *   ok: boolean,
 *   error?: string,
 *   header?: object,
 *   cables?: object[],
 *   fibers?: object[],
 *   fuses?: object[],
 * }}
 */
export function decodeSchematicLayout(buf) {
  const u8 =
    buf instanceof Uint8Array
      ? buf
      : new Uint8Array(/** @type {ArrayBuffer} */ (buf));
  if (u8.byteLength < 36) {
    return { ok: false, error: "too_short" };
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const magic = dv.getUint32(0, true);
  const version = dv.getUint32(4, true);
  if (magic !== SCHEMATIC_MAGIC) {
    return { ok: false, error: "bad_magic" };
  }
  if (version !== SCHEMATIC_VERSION) {
    return { ok: false, error: "bad_version" };
  }
  const header = {
    magic,
    version,
    cx: dv.getFloat32(8, true),
    cy: dv.getFloat32(12, true),
    radius: dv.getFloat32(16, true),
    n_cables: dv.getUint32(20, true),
    n_fibers: dv.getUint32(24, true),
    n_fuses: dv.getUint32(28, true),
    flags: dv.getUint32(32, true),
    is_tap: (dv.getUint32(32, true) & 1) !== 0,
  };

  const CABLE_SIZE = 40 + 4 * 5 + 2 + 2 + 2 + 2; /* guid + floats + packed */
  /* Verify against C: guid[40] + 5*f32 + u8 + u8 + 3*u16 = 40+20+2+6 = 68 */
  const CAB = 68;
  const FIB = 2 + 2 + 4 + 4 + 4; /* 16 */
  const FUS = 2 * 4 + 4 * 6; /* 8 + 24 = 32 */

  let o = 36; /* sizeof header: 9*u32/f32 = 36 */
  /* header is 36 bytes: magic,version,cx,cy,radius,n_cables,n_fibers,n_fuses,flags */
  const need =
    36 + header.n_cables * CAB + header.n_fibers * FIB + header.n_fuses * FUS;
  if (u8.byteLength < need) {
    return { ok: false, error: "truncated", header };
  }

  /** @type {object[]} */
  const cables = [];
  for (let i = 0; i < header.n_cables; i++) {
    const base = o + i * CAB;
    let guid = "";
    for (let k = 0; k < 40; k++) {
      const c = u8[base + k];
      if (c === 0) break;
      guid += String.fromCharCode(c);
    }
    const b = base + 40;
    cables.push({
      guid,
      approach_deg: dv.getFloat32(b, true),
      ux: dv.getFloat32(b + 4, true),
      uy: dv.getFloat32(b + 8, true),
      x: dv.getFloat32(b + 12, true),
      y: dv.getFloat32(b + 16, true),
      is_drop: u8[b + 20] !== 0,
      size: dv.getUint16(b + 22, true),
      fiber_count: dv.getUint16(b + 24, true),
      fiber_start: dv.getUint16(b + 26, true),
    });
  }
  o += header.n_cables * CAB;

  /** @type {object[]} */
  const fibers = [];
  for (let i = 0; i < header.n_fibers; i++) {
    const base = o + i * FIB;
    fibers.push({
      cable_index: dv.getUint16(base, true),
      fiber_num: dv.getUint16(base + 2, true),
      x: dv.getFloat32(base + 4, true),
      y: dv.getFloat32(base + 8, true),
      chip_r: dv.getFloat32(base + 12, true),
    });
  }
  o += header.n_fibers * FIB;

  /** @type {object[]} */
  const fuses = [];
  for (let i = 0; i < header.n_fuses; i++) {
    const base = o + i * FUS;
    fuses.push({
      a_cable: dv.getUint16(base, true),
      a_fiber: dv.getUint16(base + 2, true),
      b_cable: dv.getUint16(base + 4, true),
      b_fiber: dv.getUint16(base + 6, true),
      ax: dv.getFloat32(base + 8, true),
      ay: dv.getFloat32(base + 12, true),
      bx: dv.getFloat32(base + 16, true),
      by: dv.getFloat32(base + 20, true),
      mx: dv.getFloat32(base + 24, true),
      my: dv.getFloat32(base + 28, true),
    });
  }

  return { ok: true, header, cables, fibers, fuses };
}

/**
 * Optional: call WASM export if present.
 * @param {WebAssembly.Instance} instance
 * @param {WebAssembly.Memory} memory
 * @param {Uint8Array} jsonBytes
 * @param {{cx?:number,cy?:number,radius?:number,outCap?:number}} [opts]
 */
export function layoutViaWasm(instance, memory, jsonBytes, opts = {}) {
  const exp = instance?.exports || instance;
  const mem = memory;
  const fn = exp?.webmap_schematic_layout;
  const alloc = exp?.webmap_wasm_alloc;
  const free = exp?.webmap_wasm_free;
  if (typeof fn !== "function" || typeof alloc !== "function") {
    return { ok: false, error: "no_export" };
  }
  if (!mem?.buffer) {
    return { ok: false, error: "no_memory" };
  }
  const cx = opts.cx ?? 0;
  const cy = opts.cy ?? 0;
  const radius = opts.radius ?? 168;
  const outCap = opts.outCap ?? 65536;
  const jPtr = Number(alloc(jsonBytes.byteLength));
  const oPtr = Number(alloc(outCap));
  if (!jPtr || !oPtr) {
    return { ok: false, error: "alloc" };
  }
  try {
    new Uint8Array(mem.buffer, jPtr, jsonBytes.byteLength).set(jsonBytes);
    const n = Number(
      fn(jPtr, jsonBytes.byteLength, cx, cy, radius, oPtr, outCap)
    );
    if (!n) {
      return { ok: false, error: "layout_failed" };
    }
    /* memory.grow may detach — re-view after call */
    const slice = new Uint8Array(mem.buffer, oPtr, n).slice();
    const decoded = decodeSchematicLayout(slice);
    if (decoded.ok) decoded.source = "wasm";
    return decoded;
  } finally {
    if (typeof free === "function") {
      free(jPtr);
      free(oPtr);
    }
  }
}

/**
 * Lightweight WASM host for schematic layout only (no map context).
 * @param {{
 *   log?: (s: string) => void,
 *   mode?: "auto"|"wasm"|"js",
 *   url?: string,
 * }} [opts]
 */
export function createSchematicLayoutService(opts = {}) {
  const log = opts.log || (() => {});
  const mode = opts.mode || "auto";
  const url = opts.url || "./webmap.wasm";

  /** @type {WebAssembly.Memory|null} */
  let memory = null;
  /** @type {WebAssembly.Exports|null} */
  let exp = null;
  let ready = false;
  let sourcePreferred = mode === "js" ? "js" : mode === "wasm" ? "wasm" : "auto";
  /** @type {Map<string, object>} */
  const cache = new Map();
  const stats = { hits: 0, misses: 0, wasm_ok: 0, wasm_fail: 0, js_fallback: 0 };

  /**
   * @param {string} [wasmUrl]
   */
  async function init(wasmUrl = url) {
    if (sourcePreferred === "js") {
      ready = true;
      log("schematic layout: JS only (?schematic=js)");
      return false;
    }
    try {
      const res = await fetch(wasmUrl);
      if (!res.ok) {
        if (sourcePreferred === "wasm") {
          throw new Error(`webmap.wasm ${res.status}`);
        }
        log("schematic layout: no wasm, using JS");
        ready = true;
        return false;
      }
      const bytes = await res.arrayBuffer();
      memory = new WebAssembly.Memory({ initial: 256, maximum: 2048 });
      const { instance } = await WebAssembly.instantiate(bytes, {
        env: { memory },
      });
      exp = instance.exports;
      if (typeof exp.webmap_schematic_layout !== "function") {
        throw new Error("webmap_schematic_layout export missing");
      }
      if (typeof exp.webmap_wasm_alloc !== "function") {
        throw new Error("webmap_wasm_alloc missing");
      }
      ready = true;
      log("schematic layout: WASM ready (P4.11)");
      return true;
    } catch (e) {
      exp = null;
      memory = null;
      ready = true;
      if (sourcePreferred === "wasm") {
        log("schematic layout WASM failed: " + (e.message || e));
      } else {
        log("schematic layout: WASM unavailable, JS fallback — " + (e.message || e));
      }
      return false;
    }
  }

  function cacheKey(detail, cx, cy, radius) {
    const id = detail?.guid || detail?.sp_guid || "";
    const nCab = (detail?.cables || []).length;
    const nLink = (detail?.links || []).length;
    return `${id}|${nCab}|${nLink}|${Math.round(cx)}|${Math.round(cy)}|${Math.round(radius * 10)}`;
  }

  /**
   * Compute layout for a splice_detail object.
   * Prefers WASM; returns null on hard failure (caller uses JS geometry).
   *
   * @param {object} detail
   * @param {{cx?:number,cy?:number,radius?:number}} [geom]
   * @returns {{ok:boolean, source:string, header?:object, cables?:object[], fibers?:object[], fuses?:object[], error?:string}|null}
   */
  function layout(detail, geom = {}) {
    if (!detail || typeof detail !== "object") {
      return { ok: false, source: "none", error: "no_detail" };
    }
    const cx = geom.cx ?? 0;
    const cy = geom.cy ?? 0;
    const radius = geom.radius ?? 100;
    const key = cacheKey(detail, cx, cy, radius);
    if (cache.has(key)) {
      stats.hits++;
      return cache.get(key);
    }
    stats.misses++;

    const wantWasm =
      sourcePreferred === "wasm" ||
      (sourcePreferred === "auto" && exp && memory);

    if (wantWasm && exp && memory) {
      try {
        const json = JSON.stringify(detail);
        const bytes = new TextEncoder().encode(json);
        const decoded = layoutViaWasm(exp, memory, bytes, {
          cx,
          cy,
          radius,
          outCap: Math.max(65536, bytes.byteLength * 4),
        });
        if (decoded.ok) {
          stats.wasm_ok++;
          decoded.source = "wasm";
          cache.set(key, decoded);
          if (cache.size > 64) {
            const first = cache.keys().next().value;
            cache.delete(first);
          }
          return decoded;
        }
        stats.wasm_fail++;
        if (sourcePreferred === "wasm") {
          return { ok: false, source: "wasm", error: decoded.error || "fail" };
        }
      } catch (e) {
        stats.wasm_fail++;
        if (sourcePreferred === "wasm") {
          return { ok: false, source: "wasm", error: String(e.message || e) };
        }
      }
    }

    /* JS fallback: signal caller to use fiber_schematic JS geometry */
    stats.js_fallback++;
    const fb = { ok: false, source: "js", error: "use_js_geometry" };
    return fb;
  }

  function clearCache() {
    cache.clear();
  }

  function getMemReport() {
    return {
      ready,
      mode: sourcePreferred,
      wasm: !!(exp && memory),
      cache_entries: cache.size,
      ...stats,
    };
  }

  return {
    init,
    layout,
    clearCache,
    getMemReport,
    get ready() {
      return ready;
    },
    get hasWasm() {
      return !!(exp && memory);
    },
    get mode() {
      return sourcePreferred;
    },
    setMode(m) {
      if (m === "js" || m === "wasm" || m === "auto") {
        sourcePreferred = m;
        clearCache();
      }
    },
  };
}
