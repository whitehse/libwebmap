/**
 * P4.2 host-side LRU tile cache for GPU (and optional side payloads).
 *
 * Caps residency at maxTiles; on eviction calls onEvict(key, entry) so the
 * host can destroy WebGPU buffers and drop related Maps (hits, taps, …).
 *
 * maxTiles <= 0 means unlimited (debug / ?max_tiles=0).
 */

/**
 * Parse max_tiles from URL query; default 256 (matches webmap_config_t).
 * @param {string} [search]
 * @returns {number} 0 = unlimited
 */
export function parseMaxTilesQuery(search) {
  try {
    const q = new URLSearchParams(search ?? location.search);
    if (!q.has("max_tiles")) return 256;
    const v = Number(q.get("max_tiles"));
    if (!Number.isFinite(v) || v < 0) return 256;
    return Math.floor(v);
  } catch {
    return 256;
  }
}

/**
 * @param {{
 *   maxTiles?: number,
 *   onEvict?: (key: string, entry: unknown) => void,
 *   onReplace?: (key: string, oldEntry: unknown) => void,
 *   name?: string,
 * }} [opts]
 */
export function createTileCache(opts = {}) {
  let maxTiles =
    opts.maxTiles != null && Number.isFinite(opts.maxTiles)
      ? Math.floor(opts.maxTiles)
      : 256;
  const onEvict = typeof opts.onEvict === "function" ? opts.onEvict : null;
  const onReplace =
    typeof opts.onReplace === "function" ? opts.onReplace : onEvict;
  const name = opts.name || "tiles";

  /** @type {Map<string, { payload: unknown, stamp: number }>} */
  const map = new Map();
  let clock = 0;
  let evictions = 0;

  function touchKey(key) {
    const e = map.get(key);
    if (!e) return;
    clock++;
    e.stamp = clock;
  }

  function evictOne() {
    if (map.size === 0) return false;
    let victimKey = null;
    let best = Infinity;
    for (const [k, e] of map) {
      if (e.stamp < best) {
        best = e.stamp;
        victimKey = k;
      }
    }
    if (victimKey == null) return false;
    const entry = map.get(victimKey);
    map.delete(victimKey);
    evictions++;
    if (onEvict && entry) onEvict(victimKey, entry.payload);
    return true;
  }

  function set(key, payload) {
    if (map.has(key)) {
      const e = map.get(key);
      const old = e.payload;
      e.payload = payload;
      clock++;
      e.stamp = clock;
      /* Free previous GPU residency without treating as capacity eviction. */
      if (onReplace && old != null && old !== payload) onReplace(key, old);
      return { inserted: false, evicted: 0 };
    }
    let nEv = 0;
    if (maxTiles > 0) {
      while (map.size >= maxTiles) {
        if (!evictOne()) break;
        nEv++;
      }
    }
    clock++;
    map.set(key, { payload, stamp: clock });
    return { inserted: true, evicted: nEv };
  }

  function get(key) {
    const e = map.get(key);
    if (!e) return undefined;
    clock++;
    e.stamp = clock;
    return e.payload;
  }

  function peek(key) {
    const e = map.get(key);
    return e ? e.payload : undefined;
  }

  function has(key) {
    return map.has(key);
  }

  function deleteKey(key) {
    const e = map.get(key);
    if (!e) return false;
    map.delete(key);
    if (onEvict) onEvict(key, e.payload);
    return true;
  }

  function clear() {
    if (onEvict) {
      for (const [k, e] of map) onEvict(k, e.payload);
    }
    map.clear();
  }

  function keys() {
    return [...map.keys()];
  }

  function setMaxTiles(n) {
    maxTiles = n != null && Number.isFinite(n) ? Math.floor(n) : 0;
    if (maxTiles > 0) {
      while (map.size > maxTiles) {
        if (!evictOne()) break;
      }
    }
  }

  return {
    set,
    get,
    peek,
    has,
    delete: deleteKey,
    clear,
    keys,
    touch: touchKey,
    setMaxTiles,
    get size() {
      return map.size;
    },
    get maxTiles() {
      return maxTiles;
    },
    get evictions() {
      return evictions;
    },
    get name() {
      return name;
    },
    report() {
      return {
        name,
        size: map.size,
        max_tiles: maxTiles,
        unlimited: maxTiles <= 0,
        evictions,
      };
    },
  };
}

/**
 * Destroy WebGPU mesh list (vb/ib) and return total bytes freed if tracked.
 * @param {Array<{vb?: GPUBuffer, ib?: GPUBuffer, _gpuBytes?: number}>|null|undefined} layers
 * @returns {number} sum of _gpuBytes
 */
export function destroyGpuLayers(layers) {
  if (!layers) return 0;
  let bytes = 0;
  for (const g of layers) {
    if (!g) continue;
    if (g._gpuBytes) bytes += g._gpuBytes;
    try {
      g.vb?.destroy?.();
    } catch {
      /* ignore */
    }
    try {
      g.ib?.destroy?.();
    } catch {
      /* ignore */
    }
  }
  return bytes;
}
