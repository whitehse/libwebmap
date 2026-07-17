/**
 * Optical fiber path trace (host-only, ADR-018).
 * Loads path_index package files; builds a highlight mesh from WGS84 lonlat.
 * No graph walk — precomputed Tier B index only.
 */
import {
  TRACE_HIGHLIGHT_RGBA,
  FIBER_DIM_FACTOR,
  TRACE_MAX_CANDIDATES,
  TRACE_MAX_HOPS_UI,
  styleLineWidthPx,
} from "./fiber_style.js";

const R = 6378137.0;
const MAX_HIGHLIGHT_VERTS = 50000;

function lonLatToMerc(lon, lat) {
  const x = (R * lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

function joinNormal(merc, i, n) {
  let dx0 = 0,
    dy0 = 0,
    dx1 = 0,
    dy1 = 0;
  if (i > 0) {
    dx0 = merc[i * 2] - merc[(i - 1) * 2];
    dy0 = merc[i * 2 + 1] - merc[(i - 1) * 2 + 1];
  }
  if (i < n - 1) {
    dx1 = merc[(i + 1) * 2] - merc[i * 2];
    dy1 = merc[(i + 1) * 2 + 1] - merc[i * 2 + 1];
  }
  if (i === 0) {
    dx0 = dx1;
    dy0 = dy1;
  }
  if (i === n - 1) {
    dx1 = dx0;
    dy1 = dy0;
  }
  const l0 = Math.hypot(dx0, dy0) || 1;
  const l1 = Math.hypot(dx1, dy1) || 1;
  const nx0 = -dy0 / l0;
  const ny0 = dx0 / l0;
  const nx1 = -dy1 / l1;
  const ny1 = dx1 / l1;
  let mx = nx0 + nx1;
  let my = ny0 + ny1;
  const mlen = Math.hypot(mx, my);
  if (mlen < 1e-6) return [nx0, ny0];
  mx /= mlen;
  my /= mlen;
  const cos = mx * nx0 + my * ny0;
  if (cos < 1e-4) return [nx0, ny0];
  let scale = 1 / cos;
  if (scale > 4) scale = 4;
  return [mx * scale, my * scale];
}

/**
 * @param {{
 *   device: GPUDevice,
 *   log?: (s:string)=>void,
 *   onChange?: ()=>void,
 *   listEl?: HTMLElement|null,
 *   setDimFactor?: (f:number)=>void,
 * }} opts
 */
export function createFiberTrace(opts) {
  const {
    device,
    log = () => {},
    onChange = () => {},
    listEl = null,
    setDimFactor = () => {},
  } = opts;

  let baseUrl = "./fiber_data";
  let enabled = false;
  let meta = null;
  /** @type {Record<string, number[]>|null} */
  let cableToPaths = null;
  /** @type {Map<number, object>|null} */
  let pathsById = null;
  let pathsLoadPromise = null;

  /** @type {number[]} */
  let candidates = [];
  /** @type {number|null} */
  let selectedPathId = null;
  /** @type {object|null} */
  let highlightGpu = null;
  let lastCableGuid = "";

  function destroyHighlight() {
    if (highlightGpu) {
      try {
        highlightGpu.vb?.destroy?.();
        highlightGpu.ib?.destroy?.();
      } catch {
        /* ignore */
      }
      highlightGpu = null;
    }
  }

  function clear(silent) {
    candidates = [];
    selectedPathId = null;
    lastCableGuid = "";
    destroyHighlight();
    setDimFactor(1.0);
    renderList();
    if (!silent) onChange();
  }

  function renderList() {
    if (!listEl) return;
    if (!candidates.length) {
      listEl.hidden = true;
      listEl.innerHTML = "";
      return;
    }
    listEl.hidden = false;
    const rows = candidates.map((pid) => {
      const p = pathsById?.get(pid);
      const loss =
        p?.total_loss_db != null && Number.isFinite(p.total_loss_db)
          ? `${Number(p.total_loss_db).toFixed(2)} dB`
          : "—";
      const hops = p?.hop_count ?? "?";
      const end = p?.end_kind || "";
      const fiber = p?.start?.fiber != null ? `f${p.start.fiber}` : "";
      const sel = pid === selectedPathId ? " path-sel" : "";
      return (
        `<button type="button" class="path-item${sel}" data-path-id="${pid}">` +
        `<span class="path-id">#${pid}</span> ` +
        `<span class="path-meta">${fiber} · ${hops} hops · ${end} · ${loss}</span>` +
        `</button>`
      );
    });
    listEl.innerHTML =
      `<div class="path-list-head">` +
      `<strong>Fiber paths</strong> ` +
      `<button type="button" id="path-clear" class="path-clear">Clear</button>` +
      `</div>` +
      `<div class="path-list-body">${rows.join("")}</div>` +
      (lastCableGuid
        ? `<div class="path-list-foot">cable ${lastCableGuid.slice(0, 8)}…</div>`
        : "");

    listEl.querySelector("#path-clear")?.addEventListener("click", () => {
      clear();
    });
    listEl.querySelectorAll(".path-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = Number(btn.getAttribute("data-path-id"));
        if (Number.isFinite(id)) selectPath(id);
      });
    });
  }

  async function ensurePathsLoaded() {
    if (pathsById) return pathsById;
    if (pathsLoadPromise) return pathsLoadPromise;
    pathsLoadPromise = (async () => {
      const url = `${baseUrl.replace(/\/?$/, "/")}${
        meta?.path_index_files?.paths || "path_index/paths.jsonl"
      }`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`path_index paths ${res.status}`);
      const text = await res.text();
      const map = new Map();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj && obj.path_id != null) map.set(Number(obj.path_id), obj);
        } catch {
          /* skip bad line */
        }
      }
      pathsById = map;
      log(`path_index: loaded ${map.size} paths`);
      return map;
    })();
    try {
      return await pathsLoadPromise;
    } catch (e) {
      pathsLoadPromise = null;
      throw e;
    }
  }

  /**
   * Attach to a fiber package. Enables when path_index is present.
   * @param {object|null} man fiber manifest
   * @param {string} fiberBaseUrl e.g. "./fiber_data"
   */
  async function load(man, fiberBaseUrl) {
    clear(true);
    baseUrl = (fiberBaseUrl || "./fiber_data").replace(/\/?$/, "");
    meta = null;
    cableToPaths = null;
    pathsById = null;
    pathsLoadPromise = null;
    enabled = false;

    if (!man || !man.path_index) {
      log("path_index: not in package (path trace disabled)");
      return false;
    }

    const prefix = man.path_index_files?.meta || "path_index/meta.json";
    const cableFile =
      man.path_index_files?.cable_to_paths || "path_index/cable_to_paths.json";
    try {
      const [mRes, cRes] = await Promise.all([
        fetch(`${baseUrl}/${prefix}`),
        fetch(`${baseUrl}/${cableFile}`),
      ]);
      if (!mRes.ok || !cRes.ok) {
        log("path_index: meta/cable map missing");
        return false;
      }
      meta = await mRes.json();
      cableToPaths = await cRes.json();
      enabled = true;
      log(
        `path_index ready · format ${meta.path_index_format ?? "?"} · ` +
          `${meta.path_count ?? "?"} paths · ${Object.keys(cableToPaths).length} cables`
      );
      return true;
    } catch (e) {
      log("path_index load failed: " + e.message);
      return false;
    }
  }

  function buildHighlightMesh(lonlat, rgba) {
    destroyHighlight();
    if (!lonlat || lonlat.length < 2) return null;
    const n = Math.min(lonlat.length, MAX_HIGHLIGHT_VERTS);
    const merc = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) {
      const [mx, my] = lonLatToMerc(lonlat[i][0], lonlat[i][1]);
      merc[i * 2] = mx;
      merc[i * 2 + 1] = my;
    }
    const outVerts = new ArrayBuffer(n * 2 * 24);
    const dv = new DataView(outVerts);
    const segs = n - 1;
    const inds = new Uint32Array(segs * 6);
    let vi = 0;
    let ii = 0;
    for (let i = 0; i < n; i++) {
      const [nx, ny] = joinNormal(merc, i, n);
      const o0 = vi * 24;
      dv.setFloat32(o0, merc[i * 2], true);
      dv.setFloat32(o0 + 4, merc[i * 2 + 1], true);
      dv.setFloat32(o0 + 8, nx, true);
      dv.setFloat32(o0 + 12, ny, true);
      dv.setUint32(o0 + 16, rgba >>> 0, true);
      dv.setUint32(o0 + 20, 0, true);
      vi++;
      const o1 = vi * 24;
      dv.setFloat32(o1, merc[i * 2], true);
      dv.setFloat32(o1 + 4, merc[i * 2 + 1], true);
      dv.setFloat32(o1 + 8, -nx, true);
      dv.setFloat32(o1 + 12, -ny, true);
      dv.setUint32(o1 + 16, rgba >>> 0, true);
      dv.setUint32(o1 + 20, 0, true);
      vi++;
    }
    for (let i = 0; i < segs; i++) {
      const a = i * 2;
      const b = (i + 1) * 2;
      inds[ii++] = a;
      inds[ii++] = a + 1;
      inds[ii++] = b;
      inds[ii++] = a + 1;
      inds[ii++] = b + 1;
      inds[ii++] = b;
    }
    const vb = device.createBuffer({
      size: Math.max(vi * 24, 24),
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(vb.getMappedRange()).set(
      new Uint8Array(outVerts, 0, vi * 24)
    );
    vb.unmap();
    const ib = device.createBuffer({
      size: Math.max(ii * 4, 4),
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      mappedAtCreation: true,
    });
    new Uint8Array(ib.getMappedRange()).set(
      new Uint8Array(inds.buffer, 0, ii * 4)
    );
    ib.unmap();
    highlightGpu = {
      vb,
      ib,
      indexCount: ii,
      name: "fiber/trace",
      kind: "line",
      fiberKind: "trace",
      isTrace: true,
      order: 99,
    };
    return highlightGpu;
  }

  function selectPath(pathId) {
    const p = pathsById?.get(pathId);
    if (!p) {
      log(`path ${pathId} not in index`);
      return false;
    }
    selectedPathId = pathId;
    const lonlat = p.lonlat || [];
    if (lonlat.length < 2) {
      log(`path ${pathId} has no geometry`);
      destroyHighlight();
    } else {
      buildHighlightMesh(lonlat, TRACE_HIGHLIGHT_RGBA);
    }
    setDimFactor(FIBER_DIM_FACTOR);
    renderList();
    onChange();
    const hops = (p.hops || []).slice(0, TRACE_MAX_HOPS_UI);
    log(
      `trace path #${pathId} · ${p.hop_count ?? hops.length} hops · ` +
        `end=${p.end_kind || "?"} · verts=${lonlat.length}`
    );
    return true;
  }

  /**
   * Click cable/drop with plant GUID → candidate paths.
   * @param {string} cableGuid
   */
  async function selectByCable(cableGuid) {
    if (!enabled) {
      log("Path index not available for this package");
      return false;
    }
    const g = String(cableGuid || "").trim().toLowerCase();
    if (!g) {
      log("cable has no GUID (need .fmap v3)");
      return false;
    }
    lastCableGuid = g;
    const ids = (cableToPaths && cableToPaths[g]) || [];
    if (!ids.length) {
      candidates = [];
      selectedPathId = null;
      destroyHighlight();
      setDimFactor(1.0);
      renderList();
      log(`no paths for cable ${g.slice(0, 8)}…`);
      onChange();
      return false;
    }
    try {
      await ensurePathsLoaded();
    } catch (e) {
      log("path_index load failed: " + e.message);
      return false;
    }
    candidates = ids.slice(0, TRACE_MAX_CANDIDATES);
    if (candidates.length === 1) {
      selectPath(candidates[0]);
    } else {
      selectedPathId = null;
      destroyHighlight();
      setDimFactor(FIBER_DIM_FACTOR);
      renderList();
      onChange();
      log(`${candidates.length} paths on cable ${g.slice(0, 8)}… — pick one`);
    }
    return true;
  }

  function halfWidthForDraw(g, cam, mpp) {
    if (g?.isTrace || g?.fiberKind === "trace") {
      return styleLineWidthPx("cable", cam.zoom) * 0.75 * mpp;
    }
    return null;
  }

  function collectDraws(draws) {
    if (highlightGpu) draws.push(highlightGpu);
  }

  return {
    load,
    selectByCable,
    selectPath,
    clear,
    collectDraws,
    halfWidthForDraw,
    get enabled() {
      return enabled;
    },
    get selectedPathId() {
      return selectedPathId;
    },
    get candidates() {
      return candidates.slice();
    },
    get dimActive() {
      return selectedPathId != null || candidates.length > 0;
    },
  };
}
