/**
 * P4.4/P5/P4.13 WASM host glue: instantiate module, staging slab, .wmap → parse.
 *
 * P4.13 default path is **decode-and-drop**: load tile → copy layers to host
 * ArrayBuffers → webmap_drop_tile so the C cache does not retain a second copy
 * of the pyramid (host basemapCache / GPU buffers own residency).
 *
 * Query (parseWasmQuery):
 *   (default) / ?wasm=auto  — try WASM, fall back to JS
 *   ?wasm=1                 — force WASM
 *   ?wasm=0                 — force JS
 */

import {
  LAYER_VIEW,
  readAbiPack,
  validateAbiPack,
  WASM32_ABI_EXPECTED,
} from "./wasm_abi.js";

const DEFAULT_STAGING = 2 * 1024 * 1024; /* 2 MiB reusable slab */
const MAX_LAYERS_SCRATCH = 32;
/** Decode-and-drop only needs one resident tile (+1 spare). */
const DEFAULT_DECODE_MAX_TILES = 2;
/**
 * Smaller linear memory than the old 16 MiB default (P4.13).
 * 128 pages × 64 KiB = 8 MiB; still grows up to maximum if needed.
 */
const DEFAULT_MEMORY_INITIAL_PAGES = 128;
const DEFAULT_MEMORY_MAX_PAGES = 2048;

/**
 * @param {{
 *   log?: (s: string) => void,
 *   maxTiles?: number,
 *   stagingBytes?: number,
 *   decodeAndDrop?: boolean,
 *   memoryInitialPages?: number,
 * }} [opts]
 * decodeAndDrop (default true): drop each tile from the C cache after extract.
 */
export function createWasmHost(opts = {}) {
  const log = typeof opts.log === "function" ? opts.log : () => {};
  const decodeAndDrop = opts.decodeAndDrop !== false;
  const maxTiles =
    opts.maxTiles != null && Number.isFinite(opts.maxTiles)
      ? Math.floor(opts.maxTiles)
      : decodeAndDrop
        ? DEFAULT_DECODE_MAX_TILES
        : 256;
  const stagingWant =
    opts.stagingBytes != null && Number.isFinite(opts.stagingBytes)
      ? Math.floor(opts.stagingBytes)
      : DEFAULT_STAGING;
  const memInitial =
    opts.memoryInitialPages != null && Number.isFinite(opts.memoryInitialPages)
      ? Math.floor(opts.memoryInitialPages)
      : DEFAULT_MEMORY_INITIAL_PAGES;

  /** @type {WebAssembly.Memory|null} */
  let memory = null;
  /** @type {WebAssembly.Exports|null} */
  let exp = null;
  /** @type {ReturnType<typeof readAbiPack>|null} */
  let abi = null;
  /** @type {number} */
  let ctxPtr = 0;
  /** @type {number} */
  let stagingPtr = 0;
  let stagingCap = 0;
  /** @type {number} */
  let layerViewPtr = 0;
  /** @type {number} */
  let configPtr = 0;
  let ready = false;
  let dropTiles = 0;
  let parseCount = 0;

  function heapU8() {
    return new Uint8Array(memory.buffer);
  }

  function heapDv() {
    return new DataView(memory.buffer);
  }

  function setU32(ptr, v) {
    heapDv().setUint32(ptr, v >>> 0, true);
  }

  /**
   * Grow staging slab if needed (overwrite semantics).
   * @param {number} need
   */
  function ensureStaging(need) {
    if (stagingPtr && need <= stagingCap) return true;
    const alloc = exp.webmap_wasm_alloc;
    const free = exp.webmap_wasm_free;
    if (typeof alloc !== "function") return false;
    const n = Math.max(need, stagingWant);
    if (stagingPtr && typeof free === "function") {
      free(stagingPtr);
      stagingPtr = 0;
      stagingCap = 0;
    }
    const p = Number(alloc(n));
    if (!p) return false;
    stagingPtr = p;
    stagingCap = n;
    return true;
  }

  /**
   * @param {string} [url]
   */
  async function init(url = "./webmap.wasm") {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`webmap.wasm ${res.status}`);
    const bytes = await res.arrayBuffer();
    memory = new WebAssembly.Memory({
      initial: memInitial,
      maximum: DEFAULT_MEMORY_MAX_PAGES,
    });
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: { memory },
    });
    exp = instance.exports;
    abi = readAbiPack(memory, exp);
    const bad = validateAbiPack(abi);
    if (bad.length) {
      log("WASM ABI pack warnings: " + bad.join("; "));
    } else {
      log(
        `WASM ABI pack v${abi.version} · ptr=${abi.ptr_size} size_t=${abi.size_t_size} · layer=${abi.size_gpu_layer}B`
      );
    }

    const alloc = exp.webmap_wasm_alloc;
    if (typeof alloc !== "function") {
      throw new Error("webmap_wasm_alloc missing (rebuild wasm P4.3+)");
    }
    if (typeof exp.webmap_wasm_get_layer !== "function") {
      throw new Error("webmap_wasm_get_layer missing (rebuild wasm P4.4+)");
    }

    /* config: 4× u32 on wasm32 */
    configPtr = Number(alloc(abi.size_config || 16));
    if (!configPtr) throw new Error("alloc config failed");
    setU32(configPtr + (abi.off_cfg_event_queue || 0), 64);
    setU32(configPtr + (abi.off_cfg_max_tiles || 4), maxTiles > 0 ? maxTiles : 256);
    setU32(configPtr + (abi.off_cfg_max_overlays || 8), 4096);
    setU32(configPtr + (abi.off_cfg_max_layers || 12), 32);

    if (typeof exp.webmap_create_with_config === "function") {
      ctxPtr = Number(exp.webmap_create_with_config(configPtr));
    } else {
      ctxPtr = Number(exp.webmap_create());
    }
    if (!ctxPtr) throw new Error("webmap_create failed");

    if (!ensureStaging(stagingWant)) {
      throw new Error("staging slab alloc failed");
    }
    layerViewPtr = Number(alloc(LAYER_VIEW.size * MAX_LAYERS_SCRATCH));
    if (!layerViewPtr) throw new Error("layer view alloc failed");

    ready = true;
    log(
      `WASM host ready · staging ${stagingCap} B · max_tiles=${maxTiles > 0 ? maxTiles : 256}` +
        (decodeAndDrop ? " · decode-and-drop" : " · retain-cache") +
        ` · linear ${((memory.buffer.byteLength / (1024 * 1024)).toFixed(1))} MiB`
    );
    return true;
  }

  /**
   * Drop tile from C cache if export present.
   * @param {number} z
   * @param {number} x
   * @param {number} y
   */
  function dropTile(z, x, y) {
    if (!ready || typeof exp.webmap_drop_tile !== "function") return false;
    const rc = Number(exp.webmap_drop_tile(ctxPtr, z, x, y));
    if (rc === 0) {
      dropTiles++;
      return true;
    }
    return false;
  }

  /**
   * Parse .wmap via WASM into the same shape as parseWmap() in wmap_parse.js.
   * Copies verts/indices into host ArrayBuffers (host extrusion needs them),
   * then drops the C-side tile when decodeAndDrop is on (P4.13).
   * @param {ArrayBuffer} buf
   * @returns {{z:number,x:number,y:number,layers:object[]}}
   */
  function parseWmapViaWasm(buf) {
    if (!ready) throw new Error("wasm host not ready");
    const bytes = new Uint8Array(buf);
    if (!ensureStaging(bytes.byteLength)) {
      throw new Error("staging too small for tile");
    }
    /* memory.grow may have detached buffers — re-get views after alloc */
    heapU8().set(bytes, stagingPtr);

    const rc = Number(exp.webmap_load_wmap_tile(ctxPtr, stagingPtr, bytes.byteLength));
    if (rc !== 0) {
      throw new Error("webmap_load_wmap_tile failed " + rc);
    }

    const hd = new DataView(buf);
    const z = hd.getUint8(8);
    const x = hd.getUint32(12, true);
    const y = hd.getUint32(16, true);

    const nLayers = Number(exp.webmap_wasm_layer_count(ctxPtr, z, x, y));
    const layers = [];

    for (let i = 0; i < nLayers; i++) {
      const outPtr = layerViewPtr;
      const ok = Number(exp.webmap_wasm_get_layer(ctxPtr, z, x, y, i, outPtr));
      if (!ok) continue;
      const dv = heapDv();
      const vertsPtr = dv.getUint32(outPtr + LAYER_VIEW.vertices_ptr, true);
      const vc = dv.getUint32(outPtr + LAYER_VIEW.vertex_count, true);
      const indsPtr = dv.getUint32(outPtr + LAYER_VIEW.indices_ptr, true);
      const ic = dv.getUint32(outPtr + LAYER_VIEW.index_count, true);
      const kind = dv.getUint32(outPtr + LAYER_VIEW.kind, true);
      const fclass = dv.getUint32(outPtr + LAYER_VIEW.feature_class, true);
      const extent = dv.getUint32(outPtr + LAYER_VIEW.extent, true);
      let name = "";
      {
        const nb = new Uint8Array(memory.buffer, outPtr + LAYER_VIEW.name, 64);
        let end = 0;
        while (end < 64 && nb[end] !== 0) end++;
        name = new TextDecoder().decode(nb.subarray(0, end));
      }

      /*
       * Single host-side copy for extrusion/upload. C cache is dropped below
       * so we do not retain dual pyramid residency (P4.13 gate).
       */
      const interleaved = new ArrayBuffer(vc * 12);
      if (vc > 0 && vertsPtr) {
        new Uint8Array(interleaved).set(
          new Uint8Array(memory.buffer, vertsPtr, vc * 12)
        );
      }
      const indices = new Uint32Array(ic);
      if (ic > 0 && indsPtr) {
        indices.set(new Uint32Array(memory.buffer, indsPtr, ic));
      }
      layers.push({
        kind,
        fclass,
        name,
        extent: extent || 4096,
        interleaved,
        indices,
        vc,
        ic,
      });
    }

    if (decodeAndDrop) {
      dropTile(z, x, y);
    }
    parseCount++;
    return { z, x, y, layers };
  }

  function heapStats() {
    if (!exp) return null;
    const used =
      typeof exp.webmap_wasm_heap_used === "function"
        ? Number(exp.webmap_wasm_heap_used())
        : 0;
    const freeB =
      typeof exp.webmap_wasm_heap_free_bytes === "function"
        ? Number(exp.webmap_wasm_heap_free_bytes())
        : 0;
    const cap =
      typeof exp.webmap_wasm_heap_capacity === "function"
        ? Number(exp.webmap_wasm_heap_capacity())
        : 0;
    const over =
      typeof exp.webmap_wasm_heap_over_watermark === "function"
        ? Number(exp.webmap_wasm_heap_over_watermark())
        : 0;
    const tiles =
      typeof exp.webmap_tile_count === "function"
        ? Number(exp.webmap_tile_count(ctxPtr))
        : -1;
    return {
      used,
      free: freeB,
      capacity: cap,
      over_watermark: over,
      tile_count: tiles,
      parse_count: parseCount,
      drop_count: dropTiles,
      decode_and_drop: decodeAndDrop,
    };
  }

  function getMemory() {
    return memory;
  }

  return {
    init,
    parseWmapViaWasm,
    dropTile,
    heapStats,
    getMemory,
    get ready() {
      return ready;
    },
    get decodeAndDrop() {
      return decodeAndDrop;
    },
    get abi() {
      return abi || WASM32_ABI_EXPECTED;
    },
  };
}

/**
 * WASM basemap parse mode from query string (P4.13).
 * @param {string|null|undefined} [search]
 * @returns {"auto"|"on"|"off"}
 */
export function parseWasmQuery(search) {
  try {
    const q = new URLSearchParams(
      search ?? (typeof location !== "undefined" ? location.search : "")
    );
    const v = (q.get("wasm") || "").toLowerCase();
    if (v === "0" || v === "false" || v === "off" || v === "js" || v === "no") {
      return "off";
    }
    if (v === "1" || v === "true" || v === "on" || v === "force" || v === "yes") {
      return "on";
    }
    if (v === "auto" || v === "") {
      return "auto";
    }
    /* unknown value → auto */
    return "auto";
  } catch {
    return "auto";
  }
}

/**
 * Legacy boolean helper: true when WASM should be attempted.
 * @param {string|null|undefined} [search]
 */
export function wasmQueryWantsModule(search) {
  return parseWasmQuery(search) !== "off";
}
