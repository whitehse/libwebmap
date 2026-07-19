/**
 * P4.0 memory measurement harness (host demo).
 *
 * Attributes retained bytes into buckets that map to known hot paths:
 *   basemap GPU meshes, fiber GPU meshes, path-trace GPU, path_index JS,
 *   splice_detail cache, fiber geometry retainers (hit polylines), WASM linear
 *   memory, and Chrome JS heap (when available).
 *
 * Budgets and the operator 85→500 MB report are *outputs* of measurement —
 * see docs/guides/memory-attribution.md.
 */

/** @typedef {'basemap_gpu'|'fiber_gpu'|'trace_gpu'|'path_index_js'|'splice_detail_js'|'fiber_geom_js'|'wasm_linear'|'js_heap'|'other_js'} MemBucket */

const BUCKETS = [
  "basemap_gpu",
  "fiber_gpu",
  "trace_gpu",
  "path_index_js",
  "splice_detail_js",
  "fiber_geom_js",
  "wasm_linear",
  "js_heap",
  "other_js",
];

/**
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (n == null || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
}

/**
 * Rough UTF-16 / object overhead estimate for a parsed JSON value.
 * Prefer measured response Content-Length when available.
 * @param {unknown} v
 * @param {number} [depth]
 * @returns {number}
 */
export function estimateJsonBytes(v, depth = 0) {
  if (depth > 24) return 0;
  if (v == null) return 8;
  const t = typeof v;
  if (t === "boolean") return 4;
  if (t === "number") return 8;
  if (t === "string") return 40 + v.length * 2;
  if (ArrayBuffer.isView(v)) return v.byteLength + 64;
  if (v instanceof ArrayBuffer) return v.byteLength + 64;
  if (Array.isArray(v)) {
    let n = 48;
    for (const x of v) n += estimateJsonBytes(x, depth + 1) + 8;
    return n;
  }
  if (t === "object") {
    let n = 48;
    for (const k of Object.keys(v)) {
      n += 40 + k.length * 2;
      n += estimateJsonBytes(/** @type {Record<string, unknown>} */ (v)[k], depth + 1);
    }
    return n;
  }
  return 16;
}

/**
 * @returns {import('./mem_stats.js').MemStatsApi}
 */
export function createMemStats(opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  /** @type {Record<string, number>} */
  const gpu = {
    basemap_gpu: 0,
    fiber_gpu: 0,
    trace_gpu: 0,
  };
  /** @type {Record<string, number>} */
  const retained = {
    path_index_js: 0,
    splice_detail_js: 0,
    fiber_geom_js: 0,
    other_js: 0,
  };
  /** @type {Record<string, number>} */
  const counts = {
    basemap_tiles: 0,
    fiber_tiles: 0,
    basemap_gpu_meshes: 0,
    fiber_gpu_meshes: 0,
    splice_detail_entries: 0,
    path_index_paths: 0,
    path_index_cables: 0,
  };

  let wasmLinear = 0;
  /** @type {WebAssembly.Memory|null} */
  let wasmMemory = null;
  /** @type {'js'|'wasm'|'unknown'} basemap parse path (P4.6) */
  let parsePath = "unknown";
  let samples = 0;
  let peakJsHeap = 0;
  let peakAccounted = 0;
  /** @type {object|null} */
  let lastSnapshot = null;
  /** @type {ReturnType<typeof setInterval>|null} */
  let timer = null;
  /** @type {HTMLElement|null} */
  let hudEl = null;
  /** @type {(() => object)|null} */
  let extraCollector = null;

  const enabledByQuery = (() => {
    try {
      const q = new URLSearchParams(location.search);
      if (q.get("mem") === "0") return false;
      return true; /* default on; ?mem=0 disables HUD */
    } catch {
      return true;
    }
  })();

  /**
   * @param {'basemap_gpu'|'fiber_gpu'|'trace_gpu'} cat
   * @param {number} bytes
   */
  function addGpu(cat, bytes) {
    const n = Math.max(0, bytes | 0);
    if (!(cat in gpu)) return;
    gpu[cat] += n;
    if (cat === "basemap_gpu") counts.basemap_gpu_meshes++;
    if (cat === "fiber_gpu") counts.fiber_gpu_meshes++;
  }

  /**
   * Adjust GPU total when buffers are destroyed (optional; eviction path).
   * @param {'basemap_gpu'|'fiber_gpu'|'trace_gpu'} cat
   * @param {number} bytes
   */
  function subGpu(cat, bytes) {
    const n = Math.max(0, bytes | 0);
    if (!(cat in gpu)) return;
    gpu[cat] = Math.max(0, gpu[cat] - n);
  }

  /**
   * @param {keyof typeof retained} cat
   * @param {number} bytes
   */
  function setRetained(cat, bytes) {
    if (!(cat in retained)) return;
    retained[cat] = Math.max(0, Number(bytes) || 0);
  }

  /**
   * @param {keyof typeof counts} name
   * @param {number} n
   */
  function setCount(name, n) {
    if (!(name in counts)) return;
    counts[name] = Math.max(0, Number(n) || 0);
  }

  /**
   * @param {WebAssembly.Memory|null|undefined} mem
   */
  function setWasmMemory(mem) {
    wasmMemory = mem || null;
    if (wasmMemory && wasmMemory.buffer) {
      wasmLinear = wasmMemory.buffer.byteLength;
    } else {
      wasmLinear = 0;
    }
  }

  /**
   * @param {'js'|'wasm'|'unknown'} path
   */
  function setParsePath(path) {
    parsePath = path === "wasm" || path === "js" ? path : "unknown";
  }

  function sampleChromeHeap() {
    const m =
      typeof performance !== "undefined" &&
      /** @type {{ memory?: { usedJSHeapSize: number, totalJSHeapSize: number, jsHeapSizeLimit: number } }} */ (
        performance
      ).memory;
    if (!m) {
      return { available: false, used: 0, total: 0, limit: 0 };
    }
    return {
      available: true,
      used: m.usedJSHeapSize || 0,
      total: m.totalJSHeapSize || 0,
      limit: m.jsHeapSizeLimit || 0,
    };
  }

  function accountedSum() {
    let n = 0;
    for (const k of Object.keys(gpu)) n += gpu[k];
    for (const k of Object.keys(retained)) n += retained[k];
    n += wasmLinear;
    return n;
  }

  /**
   * @returns {object}
   */
  function snapshot() {
    if (wasmMemory && wasmMemory.buffer) {
      wasmLinear = wasmMemory.buffer.byteLength;
    }
    const heap = sampleChromeHeap();
    if (heap.used > peakJsHeap) peakJsHeap = heap.used;
    const accounted = accountedSum();
    if (accounted > peakAccounted) peakAccounted = accounted;

    /** @type {Record<string, number>} */
    const buckets = {
      basemap_gpu: gpu.basemap_gpu,
      fiber_gpu: gpu.fiber_gpu,
      trace_gpu: gpu.trace_gpu,
      path_index_js: retained.path_index_js,
      splice_detail_js: retained.splice_detail_js,
      fiber_geom_js: retained.fiber_geom_js,
      other_js: retained.other_js,
      wasm_linear: wasmLinear,
      js_heap: heap.used,
    };

    const extra = extraCollector ? extraCollector() : {};
    samples++;
    lastSnapshot = {
      v: 1,
      kind: "libwebmap_mem_snapshot",
      t: new Date().toISOString(),
      sample: samples,
      parse_path: parsePath,
      buckets,
      counts: { ...counts },
      heap,
      peaks: {
        js_heap: peakJsHeap,
        accounted,
        accounted_peak: peakAccounted,
      },
      accounted_bytes: accounted,
      notes: {
        js_heap_includes:
          "Chrome performance.memory.usedJSHeapSize includes parsed JSON, Maps, TypedArrays, and demo code heap — not a separate sum of GPU buckets.",
        gpu_bytes:
          "Host-tracked createBuffer sizes (VERTEX/INDEX). Browser GPU process may hold more; not full process RSS.",
        operator_report:
          "85→500 MiB process RSS is a hypothesis until attributed with this harness + Task Manager.",
        parse_path:
          "js = pure JS .wmap decode; wasm = freestanding module (?wasm=1). GPU mesh path is still host JS either way.",
        default_on_gate: "docs/guides/wasm-default-on-gate.md (P4.6)",
      },
      extra,
    };
    return lastSnapshot;
  }

  /**
   * @param {HTMLElement|null} el
   */
  function renderHud(el) {
    if (!el) return;
    const s = snapshot();
    const b = s.buckets;
    const lines = [
      `<div class="mem-title">Memory (P4.0 / P4.6)</div>`,
      `<div class="mem-row"><span>Basemap parse</span><code>${s.parse_path || "—"}</code></div>`,
      `<div class="mem-row"><span>Accounted Σ</span><strong>${formatBytes(s.accounted_bytes)}</strong></div>`,
      `<div class="mem-row"><span>basemap GPU</span><code>${formatBytes(b.basemap_gpu)}</code> · ${counts.basemap_tiles} tiles · ${counts.basemap_gpu_meshes} meshes</div>`,
      s.extra?.basemap
        ? `<div class="mem-row"><span>basemap cache</span><code>${s.extra.basemap.size}${s.extra.basemap.unlimited ? "" : "/" + s.extra.basemap.max_tiles}</code> · evict ${s.extra.basemap.evictions ?? 0}</div>`
        : "",
      `<div class="mem-row"><span>fiber GPU</span><code>${formatBytes(b.fiber_gpu)}</code> · ${counts.fiber_tiles} tiles · ${counts.fiber_gpu_meshes} meshes</div>`,
      s.extra?.fiber
        ? `<div class="mem-row"><span>fiber cache</span><code>${s.extra.fiber.fiber_tiles ?? "—"}${s.extra.fiber.max_tiles > 0 ? "/" + s.extra.fiber.max_tiles : ""}</code> · evict ${s.extra.fiber.evictions ?? 0}</div>`
        : "",
      `<div class="mem-row"><span>trace GPU</span><code>${formatBytes(b.trace_gpu)}</code></div>`,
      `<div class="mem-row"><span>fiber geom JS</span><code>${formatBytes(b.fiber_geom_js)}</code></div>`,
      `<div class="mem-row"><span>path_index JS</span><code>${formatBytes(b.path_index_js)}</code> · ${counts.path_index_paths} paths · ${counts.path_index_cables} cables</div>`,
      `<div class="mem-row"><span>splice_detail</span><code>${formatBytes(b.splice_detail_js)}</code> · ${counts.splice_detail_entries} cached</div>`,
      `<div class="mem-row"><span>WASM linear</span><code>${formatBytes(b.wasm_linear)}</code></div>`,
      s.heap.available
        ? `<div class="mem-row"><span>JS heap (Chrome)</span><code>${formatBytes(s.heap.used)}</code> / ${formatBytes(s.heap.total)} <span class="mem-muted">peak ${formatBytes(s.peaks.js_heap)}</span></div>`
        : `<div class="mem-row mem-warn"><span>JS heap</span><code>n/a</code> <span class="mem-muted">use Chrome/Edge; enable performance.memory</span></div>`,
      `<div class="mem-actions">`,
      `<button type="button" id="mem-snap-btn" class="mem-btn">Copy snapshot JSON</button>`,
      `<button type="button" id="mem-dl-btn" class="mem-btn">Download</button>`,
      `</div>`,
      `<p class="mem-foot">See <code>docs/guides/memory-attribution.md</code>. GPU ≠ process RSS. <code>?mem=0</code> hides HUD.</p>`,
    ];
    el.innerHTML = lines.filter(Boolean).join("\n");
    const snapBtn = el.querySelector("#mem-snap-btn");
    const dlBtn = el.querySelector("#mem-dl-btn");
    if (snapBtn) {
      snapBtn.addEventListener("click", async () => {
        const text = JSON.stringify(snapshot(), null, 2);
        try {
          await navigator.clipboard.writeText(text);
          log("mem snapshot copied to clipboard");
        } catch {
          log("mem snapshot (clipboard failed):\n" + text.slice(0, 500) + "…");
        }
      });
    }
    if (dlBtn) {
      dlBtn.addEventListener("click", () => {
        const text = JSON.stringify(snapshot(), null, 2);
        const blob = new Blob([text], { type: "application/json" });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = `libwebmap-mem-${Date.now()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        log("mem snapshot download started");
      });
    }
  }

  /**
   * @param {HTMLElement|null} el
   * @param {number} [intervalMs]
   */
  function startHud(el, intervalMs = 1500) {
    if (!enabledByQuery) {
      if (el) {
        el.hidden = true;
        el.innerHTML = "";
      }
      return;
    }
    hudEl = el;
    if (hudEl) hudEl.hidden = false;
    renderHud(hudEl);
    if (timer) clearInterval(timer);
    timer = setInterval(() => renderHud(hudEl), intervalMs);
  }

  function stopHud() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /**
   * Optional hook for modules to inject live estimates each snapshot.
   * @param {(() => object)|null} fn
   */
  function setExtraCollector(fn) {
    extraCollector = fn;
  }

  return {
    addGpu,
    subGpu,
    setRetained,
    setCount,
    setWasmMemory,
    setParsePath,
    sampleChromeHeap,
    snapshot,
    renderHud,
    startHud,
    stopHud,
    setExtraCollector,
    formatBytes,
    get enabled() {
      return enabledByQuery;
    },
    get last() {
      return lastSnapshot;
    },
  };
}

/**
 * Estimate retained JS bytes for fiber layer geometry Maps.
 * @param {Map<string, unknown[]>} tileLines
 * @param {Map<string, unknown[]>} tileTaps
 * @param {Map<string, unknown[]>} tileSplices
 */
export function estimateFiberGeomBytes(tileLines, tileTaps, tileSplices) {
  let n = 0;
  if (tileLines) {
    n += 48 * tileLines.size;
    for (const arr of tileLines.values()) {
      n += 48;
      for (const ln of arr) {
        n += 128;
        if (ln && ln.merc && ln.merc.byteLength) n += ln.merc.byteLength;
        if (ln && typeof ln.cable_guid === "string") n += 40 + ln.cable_guid.length * 2;
        if (ln && typeof ln.id === "string") n += 40 + ln.id.length * 2;
      }
    }
  }
  if (tileTaps) {
    n += 48 * tileTaps.size;
    for (const arr of tileTaps.values()) {
      n += 48 + arr.length * 96;
      for (const t of arr) {
        if (t && typeof t.sp_guid === "string") n += 40 + t.sp_guid.length * 2;
      }
    }
  }
  if (tileSplices) {
    n += 48 * tileSplices.size;
    for (const arr of tileSplices.values()) {
      n += 48 + arr.length * 80;
      for (const s of arr) {
        if (s && typeof s.sp_guid === "string") n += 40 + s.sp_guid.length * 2;
      }
    }
  }
  return n;
}

/**
 * Estimate splice_detail cache size.
 * @param {Map<string, object|null>} detailCache
 */
export function estimateDetailCacheBytes(detailCache) {
  if (!detailCache) return 0;
  let n = 48 * detailCache.size;
  for (const [k, v] of detailCache) {
    n += 40 + k.length * 2;
    if (v) n += estimateJsonBytes(v);
    else n += 8;
  }
  return n;
}
