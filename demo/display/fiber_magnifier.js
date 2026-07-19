/**
 * Fiber hover magnifier: dwell timer, detail cache, geo-oriented lens,
 * pan + zoom exploration, and paired-strand hover highlighting.
 */

import {
  HOVER_DELAY_MS,
  MAGNIFIER_RADIUS_PX,
  MAGNIFIER_OFFSET_PX,
  MAGNIFIER_PAN_RANGE_PX,
  MAGNIFIER_ZOOM_MIN,
  MAGNIFIER_ZOOM_MAX,
  MAG_BG,
  MAG_RIM,
  MAG_RIM_INNER,
} from "./fiber_style.js";
import {
  paintMagnifierContent,
  fusePairsFromLinks,
  pairEndpoints,
  fitZoomForDetail,
} from "./fiber_schematic.js";
import { estimateDetailCacheBytes } from "./mem_stats.js";

/**
 * @param {object} [opts]
 * @param {(s: string) => void} [opts.log]
 * @param {(hit: object, detail: object|null) => object|null} [opts.enrichDetail]
 * @param {(cableGuid: string, fiber?: number|null) => void} [opts.onTrace]
 * @param {(spGuid: string) => void} [opts.onOpenDiagram]
 * @param {() => void} [opts.requestPaint]
 * @param {object|null} [opts.memStats]
 * @param {{layout:Function}|null} [opts.layoutService] P4.11 schematic_layout host
 */
export function createFiberMagnifier(opts = {}) {
  const log = opts.log || (() => {});
  const enrichDetail = opts.enrichDetail || ((_, d) => d);
  const onTrace = opts.onTrace || (() => {});
  const onOpenDiagram = opts.onOpenDiagram || (() => {});
  const requestPaint = opts.requestPaint || (() => {});
  const memStats = opts.memStats || null;
  /** @type {{layout:Function}|null} */
  let layoutService = opts.layoutService || null;

  function refreshDetailMem() {
    if (!memStats) return;
    memStats.setRetained("splice_detail_js", estimateDetailCacheBytes(detailCache));
    memStats.setCount("splice_detail_entries", detailCache.size);
  }

  /** @type {object|null} */
  let pending = null;
  /** @type {{hit:object, openedAt:number}|null} */
  let active = null;
  /** @type {number|null} */
  let timer = null;
  let ptrX = 0;
  let ptrY = 0;
  let lastView = null;

  /** Pan of schematic world (CSS px). */
  let panX = 0;
  let panY = 0;
  /** In-glass zoom (1 = default). */
  let zoom = 1;
  /** Cached fuse pairs from last detail for hover pairing. */
  let lastFusePairs = [];
  /** @type {object|null} */
  let focus = null;
  /** @type {object[]} */
  let lastHits = [];
  /** @type {object|null} */
  let hoverHit = null;
  let lastClickT = 0;
  let lastClickX = 0;
  let lastClickY = 0;
  /** Last painted body center offset (for hit tests). */
  let lastBodyCy = 0;

  /** @type {Map<string, object|null>} */
  const detailCache = new Map();
  /** @type {Map<string, Promise<object|null>>} */
  const detailInflight = new Map();
  let detailBase = "./fiber_data/splice_detail/";

  function hitKey(h) {
    if (!h) return "";
    if (h.sp_guid) return `${h.kind}:${h.sp_guid}`;
    if (h.kind === "cable" || h.kind === "drop") {
      return `${h.kind}:${h.line_id || h.cable_guid || `${h.mx?.toFixed(1)},${h.my?.toFixed(1)}`}`;
    }
    return `${h.kind}:${h.mx},${h.my}`;
  }

  function clearTimer() {
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function setDetailBase(url) {
    if (url) detailBase = url.replace(/\/?$/, "/");
  }

  function ensureDetail(spGuid) {
    if (!spGuid) return Promise.resolve(null);
    if (detailCache.has(spGuid)) return Promise.resolve(detailCache.get(spGuid));
    if (detailInflight.has(spGuid)) return detailInflight.get(spGuid);

    const url = detailBase + spGuid + ".json";
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) {
          log(`splice detail ${r.status} ${spGuid.slice(0, 8)}… ← ${url}`);
          return null;
        }
        return r.json();
      })
      .then((j) => {
        detailCache.set(spGuid, j);
        detailInflight.delete(spGuid);
        refreshDetailMem();
        // Fit whole SP when detail first arrives for the open lens
        if (active?.hit?.sp_guid === spGuid && j) {
          applyFitZoom(j);
        }
        requestPaint();
        return j;
      })
      .catch((e) => {
        log(
          "splice detail fail " +
            spGuid.slice(0, 8) +
            "… ← " +
            url +
            ": " +
            e.message
        );
        detailCache.set(spGuid, null);
        detailInflight.delete(spGuid);
        refreshDetailMem();
        return null;
      });
    detailInflight.set(spGuid, p);
    return p;
  }

  function resetExploreState() {
    panX = 0;
    panY = 0;
    zoom = 1;
    focus = null;
    lastHits = [];
    hoverHit = null;
    lastFusePairs = [];
  }

  /**
   * Choose an initial zoom so the whole meet-point fits in the glass.
   * Large multi-fiber SPs start zoomed out; small ones stay at 1×.
   */
  function applyFitZoom(detail) {
    // Body radius ≈ lens radius minus chrome (title + footer)
    const bodyR = Math.max(40, MAGNIFIER_RADIUS_PX - 36);
    const z = fitZoomForDetail(detail, bodyR);
    zoom = z;
    panX = 0;
    panY = 0;
  }

  function panRange() {
    // More zoom → more room to roam
    return MAGNIFIER_PAN_RANGE_PX * (0.65 + zoom * 0.85);
  }

  /**
   * Pan toward pointer so the glass feels like a viewport over a larger map.
   */
  function updatePanFromPointer(cssX, cssY, view) {
    const layout = lensLayout(view);
    if (!layout) return;
    const nx = (cssX - layout.cssCx) / Math.max(layout.rCss, 1);
    const ny = (cssY - layout.cssCy) / Math.max(layout.rCss, 1);
    const len = Math.hypot(nx, ny);
    const cx = len > 1 ? nx / len : nx;
    const cy = len > 1 ? ny / len : ny;
    const pr = panRange();
    panX = cx * pr;
    panY = cy * pr;
  }

  function lensLocalFromPointer(cssX, cssY, view) {
    const layout = lensLayout(view);
    if (!layout) return null;
    return {
      x: cssX - layout.cssCx,
      y: cssY - layout.cssCy,
      layout,
    };
  }

  function pickHitAt(cssX, cssY, view) {
    const local = lensLocalFromPointer(cssX, cssY, view);
    if (!local || !lastHits.length) return null;
    let best = null;
    let bestD = Infinity;
    for (const h of lastHits) {
      const hx = h.lensX != null ? h.lensX : h.x;
      const hy = h.lensY != null ? h.lensY : h.y;
      const d = Math.hypot(local.x - hx, local.y - hy);
      if (d <= (h.r || 8) + 2 && d < bestD) {
        bestD = d;
        best = h;
      }
    }
    return best;
  }

  function setFocusFromFiber(cableGuid, fiber, hit) {
    if (!cableGuid || !(fiber > 0)) {
      focus = null;
      return;
    }
    const endpoints = pairEndpoints(lastFusePairs, cableGuid, fiber);
    // Through-tap / drop partners from schematic hit metadata
    if (hit?.pair_cable && hit?.pair_fiber > 0) {
      const k = `${hit.pair_cable}|${hit.pair_fiber}`;
      if (!endpoints.some((e) => `${e.cable}|${e.fiber}` === k)) {
        endpoints.push({ cable: hit.pair_cable, fiber: hit.pair_fiber });
      }
    }
    if (!endpoints.some((e) => e.cable === cableGuid && e.fiber === fiber)) {
      endpoints.unshift({ cable: cableGuid, fiber });
    }
    focus = {
      cable_guid: cableGuid,
      fiber,
      endpoints,
      throughTap:
        hit?.role === "through_in" ||
        hit?.role === "through_pt" ||
        hit?.role === "drop",
    };
  }

  /**
   * Wheel zoom while pointer is in the glass. Zooms about the cursor so
   * strands under the mouse stay put while the rest of the world scales.
   * @returns {boolean} true if consumed
   */
  function onWheel(cssX, cssY, view, deltaY) {
    if (!active?.hit) return false;
    if (!pointInLens(cssX, cssY, view)) return false;

    const layout = lensLayout(view);
    if (!layout) return false;

    // Pointer offset from lens center (CSS px) = lens-local content position
    const lx = cssX - layout.cssCx;
    const ly = cssY - layout.cssCy;

    // Content point under cursor before zoom (pan-relative)
    // lens pos = content*scale - pan  → content = (lens + pan) / scale
    // We only track pan; scale is applied in paint. Approximate:
    // Keep the same lens-local point mapping by adjusting pan after zoom.
    const oldZoom = zoom;
    // Slightly coarser steps so a few notches can go from fit-all → strand view
    const factor = deltaY > 0 ? 0.88 : 1.14;
    const next = Math.min(
      MAGNIFIER_ZOOM_MAX,
      Math.max(MAGNIFIER_ZOOM_MIN, zoom * factor)
    );
    if (Math.abs(next - oldZoom) < 1e-4) return true;

    // Scale pan so the content under the cursor stays roughly fixed:
    // pan' = pan * (next/old) + lx * (1 - next/old)  … for pure scale about origin
    // Actually: lens = content * (base*z) - pan. Want lens' = lens for same content:
    // content * base * next - pan' = content * base * old - pan
    // pan' = pan + content * base * (next - old)
    // content ≈ (lx + pan) / (base * old)  with base folded into worldScale ratio
    // Using ratio r = next/old: pan' = pan * r + lx * (1 - r) keeps lx fixed if
    // content is measured in the same units as pan.
    const r = next / oldZoom;
    panX = panX * r + lx * (1 - r);
    panY = panY * r + ly * (1 - r);
    zoom = next;
    // Keep pan anchored under the cursor (do not re-apply pointer-rim pan here)

    // Refresh hover focus at new scale
    const best = pickHitAt(cssX, cssY, view);
    hoverHit = best;
    if (best?.kind === "fiber" && best.fiber > 0) {
      setFocusFromFiber(best.cable_guid, best.fiber, best);
    }

    requestPaint();
    return true;
  }

  function onPointer(hit, cssX, cssY, view, dragging) {
    ptrX = cssX;
    ptrY = cssY;
    lastView = view;

    if (dragging) {
      cancel();
      return;
    }

    if (active) {
      const inLens = pointInLens(cssX, cssY, view);
      if (inLens) {
        updatePanFromPointer(cssX, cssY, view);
        const best = pickHitAt(cssX, cssY, view);
        hoverHit = best;
        if (best?.kind === "fiber" && best.fiber > 0) {
          setFocusFromFiber(best.cable_guid, best.fiber, best);
        } else if (best?.kind === "cable") {
          focus = { cable_guid: best.cable_guid };
        } else if (best?.kind === "equipment") {
          focus = {
            equipment: true,
            throughTap: !!best.throughTap || best.role === "tap",
          };
        } else {
          // Clear strand pair highlight when not on a chip
          if (focus?.fiber != null || focus?.endpoints) focus = null;
        }
        requestPaint();
        return;
      }
      if (hit && hitKey(hit) === hitKey(active.hit)) {
        active.hit = { ...active.hit, ...hit };
        return;
      }
      if (!hit || hitKey(hit) !== hitKey(active.hit)) {
        active = null;
        resetExploreState();
      }
    }

    if (!hit) {
      clearTimer();
      pending = null;
      return;
    }

    if (active && hitKey(hit) === hitKey(active.hit)) {
      active.hit = { ...active.hit, ...hit };
      return;
    }

    if (pending && hitKey(pending) === hitKey(hit)) {
      pending = { ...pending, ...hit };
      return;
    }

    clearTimer();
    pending = { ...hit };
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      resetExploreState();
      active = {
        hit: { ...pending },
        openedAt: performance.now(),
      };
      pending = null;
      if (active.hit.sp_guid) {
        // Cached detail → fit immediately; otherwise fit when fetch completes
        if (detailCache.has(active.hit.sp_guid)) {
          const d = detailCache.get(active.hit.sp_guid);
          if (d) applyFitZoom(d);
        }
        ensureDetail(active.hit.sp_guid).then(() => requestPaint());
      }
      requestPaint();
    }, HOVER_DELAY_MS);
  }

  function onClick(cssX, cssY, view, { altKey = false, detail = 1 } = {}) {
    if (!active?.hit) return false;
    if (!pointInLens(cssX, cssY, view)) return false;

    const best = pickHitAt(cssX, cssY, view);

    if (best?.kind === "fiber" && best.cable_guid) {
      setFocusFromFiber(best.cable_guid, best.fiber, best);
      const roleTag =
        best.role === "through_in"
          ? " [tap IN→PT]"
          : best.role === "through_pt"
            ? " [tap PT]"
            : best.role === "drop"
              ? " [tap DROP]"
              : "";
      log(
        `trace fiber f${best.fiber} on ${String(best.cable_guid).slice(0, 8)}…` +
          (best.pair_fiber != null ? ` ↔ f${best.pair_fiber}` : "") +
          roleTag
      );
      onTrace(best.cable_guid, best.fiber);
      requestPaint();
      return true;
    }
    if (best?.kind === "cable" && best.cable_guid) {
      focus = { cable_guid: best.cable_guid };
      onTrace(best.cable_guid, null);
      requestPaint();
      return true;
    }
    if (best?.kind === "equipment") {
      focus = { equipment: true };
      requestPaint();
      return true;
    }

    const now = performance.now();
    const isDbl =
      detail >= 2 ||
      (now - lastClickT < 380 &&
        Math.hypot(cssX - lastClickX, cssY - lastClickY) < 12);
    lastClickT = now;
    lastClickX = cssX;
    lastClickY = cssY;

    if (
      (isDbl || altKey) &&
      active.hit.sp_guid &&
      (active.hit.kind === "tap" || active.hit.kind === "splice")
    ) {
      onOpenDiagram(active.hit.sp_guid);
      return true;
    }
    return true;
  }

  function cancel() {
    clearTimer();
    pending = null;
    active = null;
    resetExploreState();
  }

  function pointInLens(cssX, cssY, view) {
    const layout = lensLayout(view);
    if (!layout) return false;
    const d = Math.hypot(cssX - layout.cssCx, cssY - layout.cssCy);
    return d <= layout.rCss + 6;
  }

  function lensLayout(view) {
    if (!active?.hit) return null;
    const dpr = view?.dpr || lastView?.dpr || 1;
    const vw = view?.w || lastView?.w || 800;
    const vh = view?.h || lastView?.h || 600;
    const rCss = MAGNIFIER_RADIUS_PX;
    const hit = active.hit;

    let fx = hit.screenCssX;
    let fy = hit.screenCssY;
    if (fx == null || fy == null) {
      fx = ptrX;
      fy = ptrY;
    }

    let ox = MAGNIFIER_OFFSET_PX + rCss * 0.12;
    let oy = -MAGNIFIER_OFFSET_PX * 0.3;
    if (fx + ox + rCss > vw - 8) ox = -ox;
    if (fy + oy - rCss < 8) oy = MAGNIFIER_OFFSET_PX * 0.45;
    if (fy + oy + rCss > vh - 8) oy = -rCss * 0.35;

    let cssCx = fx + ox;
    let cssCy = fy + oy;

    // Soft follow while exploring
    if (active && Math.hypot(ptrX - cssCx, ptrY - cssCy) < rCss + 24) {
      cssCx = cssCx * 0.88 + ptrX * 0.12;
      cssCy = cssCy * 0.88 + ptrY * 0.12;
    }

    cssCx = Math.max(rCss + 4, Math.min(vw - rCss - 4, cssCx));
    cssCy = Math.max(rCss + 4, Math.min(vh - rCss - 4, cssCy));

    return {
      cssCx,
      cssCy,
      rCss,
      devCx: cssCx * dpr,
      devCy: cssCy * dpr,
      rDev: rCss * dpr,
      dpr,
    };
  }

  /**
   * Paint magnifier content (and optionally Canvas chrome).
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} view
   * @param {{ chrome?: "canvas"|"gpu"|"none" }} [opts]
   *   chrome: "canvas" (default) draws fill/rim/tick on 2D;
   *           "gpu" skips fill/rim/tick (WebGPU glass_lens_gpu draws them);
   *           "none" schematic only.
   */
  function paint(ctx, view, opts = {}) {
    if (!active?.hit || !ctx) return;
    const layout = lensLayout(view);
    if (!layout) return;

    const chrome = opts.chrome || "canvas";
    const drawChrome = chrome === "canvas";

    const { devCx, devCy, rDev, rCss } = layout;
    const hit = active.hit;
    let detailObj = undefined;
    if (hit.sp_guid) {
      if (detailCache.has(hit.sp_guid)) {
        detailObj = detailCache.get(hit.sp_guid);
      } else {
        ensureDetail(hit.sp_guid);
      }
    }

    if (detailObj && typeof detailObj === "object") {
      detailObj = enrichDetail(hit, detailObj) || detailObj;
      lastFusePairs = fusePairsFromLinks(detailObj.links || []);
    } else {
      lastFusePairs = [];
    }

    ctx.save();

    if (drawChrome) {
      ctx.beginPath();
      ctx.arc(devCx + 2 * layout.dpr, devCy + 3 * layout.dpr, rDev, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(0,0,0,0.35)"; /* --glass shadow under lens */
      ctx.fill();

      ctx.beginPath();
      ctx.arc(devCx, devCy, rDev, 0, Math.PI * 2);
      ctx.fillStyle = MAG_BG; /* --glass-bg-lens */
      ctx.fill();

      ctx.lineWidth = Math.max(2, 2.5 * layout.dpr);
      ctx.strokeStyle = MAG_RIM; /* --glass-rim */
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(devCx, devCy, rDev - 3 * layout.dpr, 0, Math.PI * 2);
      ctx.strokeStyle = MAG_RIM_INNER; /* --glass-rim-inner */
      ctx.lineWidth = Math.max(1, layout.dpr);
      ctx.stroke();
    } else if (chrome === "gpu") {
      /* GPU disc is opaque-ish under labels; keep a light transparent pad so
       * schematic text remains readable if GPU alpha is low. */
      ctx.beginPath();
      ctx.arc(devCx, devCy, rDev - 2 * layout.dpr, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(12, 16, 24, 0.55)";
      ctx.fill();
    }

    ctx.beginPath();
    ctx.arc(devCx, devCy, rDev - 4 * layout.dpr, 0, Math.PI * 2);
    ctx.clip();

    ctx.save();
    ctx.translate(devCx, devCy);
    ctx.scale(layout.dpr, layout.dpr);
    const painted = paintMagnifierContent(
      ctx,
      0,
      0,
      rCss - 4,
      hit,
      detailObj,
      {
        pan: { x: panX, y: panY },
        zoom,
        focus,
        hoverHit,
        layoutService,
      }
    );
    lastHits = painted.hits || [];
    lastBodyCy = painted.bodyCy || 0;
    ctx.restore();

    if (drawChrome) {
      // North tick on rim
      ctx.beginPath();
      ctx.moveTo(devCx, devCy - rDev + 2 * layout.dpr);
      ctx.lineTo(devCx, devCy - rDev + 10 * layout.dpr);
      ctx.strokeStyle = "rgba(255,255,255,0.35)"; /* --glass-rim-tick */
      ctx.lineWidth = Math.max(1, layout.dpr);
      ctx.stroke();
    }

    ctx.restore();
  }

  return {
    onPointer,
    onClick,
    onWheel,
    cancel,
    paint,
    /** Device/CSS lens geometry for GPU chrome (P4.12). */
    getLensLayout: lensLayout,
    setDetailBase,
    ensureDetail,
    pointInLens,
    setLayoutService(svc) {
      layoutService = svc || null;
    },
    get layoutService() {
      return layoutService;
    },
    getDetailCache: () => detailCache,
    getMemReport: () => ({
      entries: detailCache.size,
      bytes: estimateDetailCacheBytes(detailCache),
      schematic: layoutService?.getMemReport?.() ?? null,
    }),
    get active() {
      return active;
    },
    get isOpen() {
      return !!active;
    },
    get focus() {
      return focus;
    },
    get zoom() {
      return zoom;
    },
  };
}
