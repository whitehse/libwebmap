/**
 * Fiber meet-point magnifier: click-to-open glass, true-bearing schematic,
 * inspect vs navigate modes, pan/zoom of the schematic world, and mobile
 * long-press / pinch support.
 *
 * Modes
 *  - inspect (default): zoom (wheel/pinch), pick fiber chips, path-trace
 *  - navigate: drag moves the glass focus along the map; nearest SP loads
 *
 * Desktop: click SP → glass; double-click SP → splice diagram.
 * Mobile: tap SP → glass; long-press SP → diagram; long-press in glass
 * toggles inspect ↔ navigate.
 */

import {
  MAGNIFIER_RADIUS_PX,
  MAGNIFIER_PAN_RANGE_PX,
  MAGNIFIER_ZOOM_MIN,
  MAGNIFIER_ZOOM_MAX,
  MAGNIFIER_EXPAND_TUBES_ZOOM,
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

/** Long-press threshold (ms) for mode toggle / SP diagram. */
export const LONG_PRESS_MS = 480;
/** Movement cancel for long-press (CSS px). */
export const LONG_PRESS_SLOP_PX = 10;

/**
 * @param {object} [opts]
 * @param {(s: string) => void} [opts.log]
 * @param {(hit: object, detail: object|null) => object|null} [opts.enrichDetail]
 * @param {(cableGuid: string, fiber?: number|null) => void} [opts.onTrace]
 * @param {(spGuid: string) => void} [opts.onOpenDiagram]
 * @param {() => void} [opts.requestPaint]
 * @param {object|null} [opts.memStats]
 * @param {{layout:Function}|null} [opts.layoutService] P4.11 schematic_layout host
 * @param {(mx: number, my: number, maxDistM?: number) => object|null} [opts.pickNearestSp]
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
  /** @type {(mx: number, my: number, maxDistM?: number) => object|null} */
  let pickNearestSp = opts.pickNearestSp || (() => null);

  function refreshDetailMem() {
    if (!memStats) return;
    memStats.setRetained("splice_detail_js", estimateDetailCacheBytes(detailCache));
    memStats.setCount("splice_detail_entries", detailCache.size);
  }

  /** @type {{hit:object, openedAt:number}|null} */
  let active = null;
  /**
   * Glass focus on the map (mercator meters). Lens is centered here.
   * @type {{mx:number, my:number}|null}
   */
  let focusMerc = null;
  /** @type {'inspect'|'navigate'} */
  let mode = "inspect";
  let ptrX = 0;
  let ptrY = 0;
  let lastView = null;

  /** Pan of schematic world (CSS px) — inspect mode only. */
  let panX = 0;
  let panY = 0;
  /** In-glass zoom (1 = default). */
  let zoom = 1;
  /** Cached fuse pairs from last detail for pairing. */
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

  /** Screen projection of focus (CSS), refreshed each paint. */
  let lastFocusCssX = 0;
  let lastFocusCssY = 0;
  /** @type {((mx:number, my:number) => [number, number])|null} */
  let toScreenCss = null;
  /** @type {((cssX:number, cssY:number) => [number, number])|null} */
  let screenToMerc = null;

  /** Navigate drag state. */
  let navDragging = false;
  let navLastCssX = 0;
  let navLastCssY = 0;

  /** Inspect-mode schematic pan drag. */
  let inspectDragging = false;
  let inspectLastX = 0;
  let inspectLastY = 0;

  /** Pinch state. */
  let pinchDist0 = 0;
  let pinchZoom0 = 1;

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

  function setDetailBase(url) {
    if (url) detailBase = url.replace(/\/?$/, "/");
  }

  function setPickNearestSp(fn) {
    pickNearestSp = typeof fn === "function" ? fn : () => null;
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
    mode = "inspect";
    navDragging = false;
    inspectDragging = false;
    pinchDist0 = 0;
  }

  /**
   * Choose an initial zoom so the whole meet-point fits in the glass.
   */
  function applyFitZoom(detail) {
    const bodyR = Math.max(40, MAGNIFIER_RADIUS_PX - 36);
    const z = fitZoomForDetail(detail, bodyR);
    zoom = z;
    panX = 0;
    panY = 0;
  }

  function panRange() {
    return MAGNIFIER_PAN_RANGE_PX * (0.65 + zoom * 0.85);
  }

  function clampPan() {
    const pr = panRange() * 2.5;
    panX = Math.max(-pr, Math.min(pr, panX));
    panY = Math.max(-pr, Math.min(pr, panY));
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
   * Open the glass on a map feature (tap / splice).
   * @returns {boolean}
   */
  function open(hit, view) {
    if (!hit || (hit.kind !== "tap" && hit.kind !== "splice")) return false;
    if (!hit.sp_guid && hit.mx == null) return false;

    resetExploreState();
    active = {
      hit: { ...hit },
      openedAt: performance.now(),
    };
    if (hit.mx != null && hit.my != null) {
      focusMerc = { mx: hit.mx, my: hit.my };
    } else {
      focusMerc = null;
    }
    if (view) lastView = view;
    mode = "inspect";

    if (active.hit.sp_guid) {
      if (detailCache.has(active.hit.sp_guid)) {
        const d = detailCache.get(active.hit.sp_guid);
        if (d) applyFitZoom(d);
      }
      ensureDetail(active.hit.sp_guid).then(() => requestPaint());
    }
    log(
      `glass open ${hit.kind} ${String(hit.sp_guid || "").slice(0, 8)}…`
    );
    requestPaint();
    return true;
  }

  /**
   * Switch glass content to a nearby SP while navigating.
   */
  function adoptSp(hit) {
    if (!hit || !active) return;
    if (hitKey(hit) === hitKey(active.hit)) {
      active.hit = { ...active.hit, ...hit };
      return;
    }
    active.hit = { ...hit };
    active.openedAt = performance.now();
    panX = 0;
    panY = 0;
    focus = null;
    hoverHit = null;
    lastHits = [];
    lastFusePairs = [];
    if (hit.mx != null && hit.my != null) {
      // Soft-snap focus toward the SP while keeping drag fluid
      if (focusMerc) {
        focusMerc.mx = focusMerc.mx * 0.35 + hit.mx * 0.65;
        focusMerc.my = focusMerc.my * 0.35 + hit.my * 0.65;
      } else {
        focusMerc = { mx: hit.mx, my: hit.my };
      }
    }
    if (hit.sp_guid) {
      if (detailCache.has(hit.sp_guid)) {
        const d = detailCache.get(hit.sp_guid);
        if (d) applyFitZoom(d);
      } else {
        zoom = 1;
      }
      ensureDetail(hit.sp_guid).then(() => requestPaint());
    }
    requestPaint();
  }

  function setMode(next) {
    if (next !== "inspect" && next !== "navigate") return;
    if (mode === next) return;
    mode = next;
    navDragging = false;
    inspectDragging = false;
    log(mode === "navigate" ? "glass: navigate (drag to move)" : "glass: inspect");
    requestPaint();
  }

  function toggleMode() {
    setMode(mode === "inspect" ? "navigate" : "inspect");
  }

  /**
   * Wheel zoom while pointer is in the glass.
   * @returns {boolean} true if consumed
   */
  function onWheel(cssX, cssY, view, deltaY) {
    if (!active?.hit) return false;
    if (!pointInLens(cssX, cssY, view)) return false;
    return applyZoomAt(cssX, cssY, view, deltaY > 0 ? 0.88 : 1.14);
  }

  function applyZoomAt(cssX, cssY, view, factor) {
    const layout = lensLayout(view);
    if (!layout) return false;

    const lx = cssX - layout.cssCx;
    const ly = cssY - layout.cssCy;
    const oldZoom = zoom;
    const next = Math.min(
      MAGNIFIER_ZOOM_MAX,
      Math.max(MAGNIFIER_ZOOM_MIN, zoom * factor)
    );
    if (Math.abs(next - oldZoom) < 1e-4) return true;

    const r = next / oldZoom;
    panX = panX * r + lx * (1 - r);
    panY = panY * r + ly * (1 - r);
    zoom = next;
    clampPan();

    const best = pickHitAt(cssX, cssY, view);
    hoverHit = best;
    if (best?.kind === "fiber" && best.fiber > 0) {
      setFocusFromFiber(best.cable_guid, best.fiber, best);
    }

    requestPaint();
    return true;
  }

  /**
   * Pinch zoom (two-finger). Call with current distance each move.
   * @returns {boolean}
   */
  function onPinchStart(dist, cssMidX, cssMidY, view) {
    if (!active?.hit) return false;
    if (!pointInLens(cssMidX, cssMidY, view) && mode === "inspect") {
      // Allow pinch if either finger likely near glass — mid-point check
      const layout = lensLayout(view);
      if (!layout) return false;
      if (Math.hypot(cssMidX - layout.cssCx, cssMidY - layout.cssCy) > layout.rCss + 40)
        return false;
    }
    pinchDist0 = Math.max(1, dist);
    pinchZoom0 = zoom;
    return true;
  }

  function onPinchMove(dist, cssMidX, cssMidY, view) {
    if (!active?.hit || !(pinchDist0 > 0)) return false;
    const factor = Math.max(0.05, dist / pinchDist0);
    const target = Math.min(
      MAGNIFIER_ZOOM_MAX,
      Math.max(MAGNIFIER_ZOOM_MIN, pinchZoom0 * factor)
    );
    const oldZoom = zoom;
    if (Math.abs(target - oldZoom) < 1e-4) return true;
    const layout = lensLayout(view);
    if (layout) {
      const lx = cssMidX - layout.cssCx;
      const ly = cssMidY - layout.cssCy;
      const r = target / oldZoom;
      panX = panX * r + lx * (1 - r);
      panY = panY * r + ly * (1 - r);
      clampPan();
    }
    zoom = target;
    requestPaint();
    return true;
  }

  function onPinchEnd() {
    pinchDist0 = 0;
  }

  /**
   * Pointer move while glass is open (inspect highlight / navigate drag /
   * inspect schematic pan). Does not open the glass.
   */
  function onPointerMove(cssX, cssY, view) {
    if (!active) return false;
    ptrX = cssX;
    ptrY = cssY;
    lastView = view;

    if (mode === "navigate" && navDragging) {
      const dx = cssX - navLastCssX;
      const dy = cssY - navLastCssY;
      navLastCssX = cssX;
      navLastCssY = cssY;
      moveFocusByScreenDelta(dx, dy, view);
      return true;
    }

    if (mode === "inspect" && inspectDragging) {
      const dx = cssX - inspectLastX;
      const dy = cssY - inspectLastY;
      inspectLastX = cssX;
      inspectLastY = cssY;
      // Drag content with finger (map-in-glass pan)
      panX -= dx;
      panY -= dy;
      clampPan();
      requestPaint();
      return true;
    }

    if (mode === "inspect" && pointInLens(cssX, cssY, view)) {
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
      } else if (focus?.fiber != null || focus?.endpoints) {
        focus = null;
      }
      requestPaint();
      return true;
    }
    return false;
  }

  function moveFocusByScreenDelta(dxCss, dyCss, view) {
    if (!focusMerc || !screenToMerc || !toScreenCss) {
      // Fallback: shift last known screen and re-pick SP only
      if (toScreenCss && focusMerc) {
        /* no-op without inverse */
      }
      requestPaint();
      return;
    }
    const [sx0, sy0] = toScreenCss(focusMerc.mx, focusMerc.my);
    const [nmx, nmy] = screenToMerc(sx0 + dxCss, sy0 + dyCss);
    focusMerc = { mx: nmx, my: nmy };

    // Adopt nearest splicepoint under / near the glass focus
    const near = pickNearestSp(focusMerc.mx, focusMerc.my, 80);
    if (near) adoptSp(near);
    else requestPaint();
  }

  /**
   * Begin a drag gesture inside the glass.
   * @returns {boolean} true if glass consumed the gesture
   */
  function onPointerDown(cssX, cssY, view) {
    if (!active?.hit) return false;
    if (!pointInLens(cssX, cssY, view)) return false;
    ptrX = cssX;
    ptrY = cssY;
    lastView = view;

    if (mode === "navigate") {
      navDragging = true;
      navLastCssX = cssX;
      navLastCssY = cssY;
      return true;
    }

    // Inspect: start potential schematic pan (cancelled if it's a click on a chip)
    inspectDragging = true;
    inspectLastX = cssX;
    inspectLastY = cssY;
    return true;
  }

  function onPointerUp(cssX, cssY, view) {
    const wasNav = navDragging;
    const wasInspect = inspectDragging;
    navDragging = false;
    inspectDragging = false;
    if (!active) return false;
    if (wasNav || wasInspect) {
      // Snap focus to adopted SP center when releasing navigate drag
      if (wasNav && active.hit?.mx != null) {
        focusMerc = { mx: active.hit.mx, my: active.hit.my };
        requestPaint();
      }
      return true;
    }
    return pointInLens(cssX, cssY, view);
  }

  /**
   * Click inside glass: fiber trace / double-click diagram.
   * @returns {boolean} true if consumed
   */
  function onClick(cssX, cssY, view, { altKey = false, detail = 1 } = {}) {
    if (!active?.hit) return false;
    if (!pointInLens(cssX, cssY, view)) return false;

    // In navigate mode, click does not pick chips
    if (mode === "navigate") return true;

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
          roleTag +
          " → full path + taps"
      );
      onTrace(best.cable_guid, best.fiber);
      requestPaint();
      return true;
    }
    if (best?.kind === "tube" && best.cable_guid) {
      // Intact tube click: focus that tube; zoom hint for fiber breakout
      focus = {
        cable_guid: best.cable_guid,
        tubeIdx: best.tubeIdx,
      };
      log(
        `${best.label || "tube"} on ${String(best.cable_guid).slice(0, 8)}… · ` +
          `zoom in (≥${MAGNIFIER_EXPAND_TUBES_ZOOM}×) to break out all 12 fibers`
      );
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

  function openDiagramForActive() {
    if (active?.hit?.sp_guid) {
      onOpenDiagram(active.hit.sp_guid);
      return true;
    }
    return false;
  }

  function cancel() {
    active = null;
    focusMerc = null;
    resetExploreState();
    requestPaint();
  }

  function pointInLens(cssX, cssY, view) {
    const layout = lensLayout(view);
    if (!layout) return false;
    const d = Math.hypot(cssX - layout.cssCx, cssY - layout.cssCy);
    return d <= layout.rCss + 6;
  }

  /**
   * Refresh projection helpers from the fiber layer each frame.
   * @param {object} helpers
   * @param {(mx:number,my:number)=>[number,number]} helpers.toScreenCss
   * @param {(cssX:number,cssY:number)=>[number,number]} helpers.screenToMerc
   * @param {object} [helpers.view]
   */
  function setProjection(helpers) {
    toScreenCss = helpers.toScreenCss || null;
    screenToMerc = helpers.screenToMerc || null;
    if (helpers.view) lastView = helpers.view;
  }

  function lensLayout(view) {
    if (!active?.hit) return null;
    const dpr = view?.dpr || lastView?.dpr || 1;
    const vw = view?.w || lastView?.w || 800;
    const vh = view?.h || lastView?.h || 600;
    const rCss = MAGNIFIER_RADIUS_PX;
    const hit = active.hit;

    let fx;
    let fy;
    if (focusMerc && toScreenCss) {
      const p = toScreenCss(focusMerc.mx, focusMerc.my);
      fx = p[0];
      fy = p[1];
    } else if (hit.screenCssX != null && hit.screenCssY != null) {
      fx = hit.screenCssX;
      fy = hit.screenCssY;
    } else if (hit.mx != null && hit.my != null && toScreenCss) {
      const p = toScreenCss(hit.mx, hit.my);
      fx = p[0];
      fy = p[1];
    } else {
      fx = ptrX;
      fy = ptrY;
    }
    lastFocusCssX = fx;
    lastFocusCssY = fy;

    // Glass is centered on the focus point (map-in-lens metaphor).
    // Slight nudge only when the focus sits on the view edge.
    let cssCx = fx;
    let cssCy = fy;
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
      mode,
      focusCssX: fx,
      focusCssY: fy,
    };
  }

  /**
   * Paint magnifier content (and optionally Canvas chrome).
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} view
   * @param {{ chrome?: "canvas"|"gpu"|"none" }} [paintOpts]
   */
  function paint(ctx, view, paintOpts = {}) {
    if (!active?.hit || !ctx) return;
    const layout = lensLayout(view);
    if (!layout) return;

    const chrome = paintOpts.chrome || "canvas";
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
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fill();

      ctx.beginPath();
      ctx.arc(devCx, devCy, rDev, 0, Math.PI * 2);
      ctx.fillStyle = MAG_BG;
      ctx.fill();

      // Navigate mode: warmer rim so the mode is obvious on mobile
      ctx.lineWidth = Math.max(2, 2.5 * layout.dpr);
      ctx.strokeStyle =
        mode === "navigate" ? "rgba(255, 190, 90, 0.85)" : MAG_RIM;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(devCx, devCy, rDev - 3 * layout.dpr, 0, Math.PI * 2);
      ctx.strokeStyle =
        mode === "navigate"
          ? "rgba(255, 220, 140, 0.35)"
          : MAG_RIM_INNER;
      ctx.lineWidth = Math.max(1, layout.dpr);
      ctx.stroke();
    } else if (chrome === "gpu") {
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
        mode,
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
      ctx.strokeStyle =
        mode === "navigate"
          ? "rgba(255, 200, 100, 0.7)"
          : "rgba(255,255,255,0.35)";
      ctx.lineWidth = Math.max(1, layout.dpr);
      ctx.stroke();

      // Mode badge
      ctx.fillStyle =
        mode === "navigate"
          ? "rgba(255, 190, 90, 0.95)"
          : "rgba(160, 200, 255, 0.75)";
      ctx.font = `600 ${Math.max(9, 9 * layout.dpr)}px system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(
        mode === "navigate" ? "MOVE" : "INSPECT",
        devCx,
        devCy + rDev - 16 * layout.dpr
      );
    }

    ctx.restore();
  }

  return {
    open,
    openDiagramForActive,
    onClick,
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPinchStart,
    onPinchMove,
    onPinchEnd,
    toggleMode,
    setMode,
    cancel,
    paint,
    setProjection,
    setPickNearestSp,
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
    get mode() {
      return mode;
    },
    get focus() {
      return focus;
    },
    get zoom() {
      return zoom;
    },
    get focusMerc() {
      return focusMerc;
    },
  };
}
