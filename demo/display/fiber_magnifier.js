/**
 * Fiber hover magnifier: dwell timer, detail cache, lens layout + paint.
 */

import {
  HOVER_DELAY_MS,
  MAGNIFIER_RADIUS_PX,
  MAGNIFIER_OFFSET_PX,
  MAG_BG,
  MAG_RIM,
  MAG_RIM_INNER,
} from "./fiber_style.js";
import { paintMagnifierContent } from "./fiber_schematic.js";

/**
 * @param {{
 *   log?: (s: string) => void
 * }} opts
 */
export function createFiberMagnifier(opts = {}) {
  const log = opts.log || (() => {});

  /** @type {ReturnType<typeof nullHit>} */
  let pending = null;
  /** @type {ReturnType<typeof nullHit>} */
  let active = null;
  /** @type {number|null} */
  let timer = null;
  /** CSS pointer position (for sticky hit + lens side). */
  let ptrX = 0;
  let ptrY = 0;
  /** Last known dpr / view for sticky tests. */
  let lastView = null;

  /** @type {Map<string, object|null>} guid → detail JSON or null if missing */
  const detailCache = new Map();
  /** @type {Map<string, Promise<object|null>>} */
  const detailInflight = new Map();
  let detailBase = "./fiber_data/splice_detail/";

  function nullHit() {
    return null;
  }

  function hitKey(h) {
    if (!h) return "";
    if (h.sp_guid) return `${h.kind}:${h.sp_guid}`;
    if (h.kind === "cable" || h.kind === "drop") {
      return `${h.kind}:${h.line_id || `${h.mx?.toFixed(1)},${h.my?.toFixed(1)}`}`;
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

  /**
   * Prefetch / load compact splice detail JSON.
   * @returns {Promise<object|null>}
   */
  function ensureDetail(spGuid) {
    if (!spGuid) return Promise.resolve(null);
    if (detailCache.has(spGuid)) return Promise.resolve(detailCache.get(spGuid));
    if (detailInflight.has(spGuid)) return detailInflight.get(spGuid);

    const url = detailBase + spGuid + ".json";
    const p = fetch(url)
      .then((r) => {
        if (!r.ok) {
          log(
            `splice detail ${r.status} ${spGuid.slice(0, 8)}… ← ${url}`
          );
          return null;
        }
        return r.json();
      })
      .then((j) => {
        detailCache.set(spGuid, j);
        detailInflight.delete(spGuid);
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
        return null;
      });
    detailInflight.set(spGuid, p);
    return p;
  }

  /**
   * Pointer moved. `hit` may be null (left feature).
   * @param {object|null} hit from fiberLayer.pick
   * @param {number} cssX
   * @param {number} cssY
   * @param {{dpr?:number,w?:number,h?:number}|null} view
   * @param {boolean} dragging
   */
  function onPointer(hit, cssX, cssY, view, dragging) {
    ptrX = cssX;
    ptrY = cssY;
    lastView = view;

    if (dragging) {
      cancel();
      return;
    }

    // Sticky: keep active open while over lens or same feature
    if (active) {
      if (hit && hitKey(hit) === hitKey(active.hit)) {
        active.hit = { ...active.hit, ...hit };
        return;
      }
      if (pointInLens(cssX, cssY, view)) return;
      // left feature and lens
      if (!hit || hitKey(hit) !== hitKey(active.hit)) {
        active = null;
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

    // New candidate
    clearTimer();
    pending = { ...hit };
    timer = setTimeout(() => {
      timer = null;
      if (!pending) return;
      active = {
        hit: { ...pending },
        openedAt: performance.now(),
      };
      pending = null;
      if (active.hit.sp_guid) {
        ensureDetail(active.hit.sp_guid).then(() => {
          /* next frame paintSymbols will pick up cache */
        });
      }
    }, HOVER_DELAY_MS);
  }

  function cancel() {
    clearTimer();
    pending = null;
    active = null;
  }

  function pointInLens(cssX, cssY, view) {
    const layout = lensLayout(view);
    if (!layout) return false;
    const d = Math.hypot(cssX - layout.cssCx, cssY - layout.cssCy);
    return d <= layout.rCss + 4;
  }

  /**
   * Compute lens center in CSS px + device px.
   */
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
      // fall back to pointer
      fx = ptrX;
      fy = ptrY;
    }

    // Prefer offset to the side with more room
    let ox = MAGNIFIER_OFFSET_PX + rCss * 0.15;
    let oy = -MAGNIFIER_OFFSET_PX * 0.35;
    if (fx + ox + rCss > vw - 8) ox = -ox;
    if (fy + oy - rCss < 8) oy = MAGNIFIER_OFFSET_PX * 0.5;
    if (fy + oy + rCss > vh - 8) oy = -rCss * 0.4;

    let cssCx = fx + ox;
    let cssCy = fy + oy;
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
   * Draw glass rim + content. Call after normal symbols.
   * @param {CanvasRenderingContext2D} ctx
   * @param {object} view { dpr, w, h }
   */
  function paint(ctx, view) {
    if (!active?.hit || !ctx) return;
    const layout = lensLayout(view);
    if (!layout) return;

    const { devCx, devCy, rDev, rCss } = layout;
    const hit = active.hit;
    // undefined = not loaded yet; null = missing; object = ok
    let detailObj = undefined;
    if (hit.sp_guid) {
      if (detailCache.has(hit.sp_guid)) {
        detailObj = detailCache.get(hit.sp_guid);
      } else {
        ensureDetail(hit.sp_guid);
      }
    }

    ctx.save();

    // Soft shadow
    ctx.beginPath();
    ctx.arc(devCx + 2 * layout.dpr, devCy + 3 * layout.dpr, rDev, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.fill();

    // Glass disc
    ctx.beginPath();
    ctx.arc(devCx, devCy, rDev, 0, Math.PI * 2);
    ctx.fillStyle = MAG_BG;
    ctx.fill();

    // Rim
    ctx.lineWidth = Math.max(2, 2.5 * layout.dpr);
    ctx.strokeStyle = MAG_RIM;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(devCx, devCy, rDev - 3 * layout.dpr, 0, Math.PI * 2);
    ctx.strokeStyle = MAG_RIM_INNER;
    ctx.lineWidth = Math.max(1, layout.dpr);
    ctx.stroke();

    // Clip content to inner circle
    ctx.beginPath();
    ctx.arc(devCx, devCy, rDev - 4 * layout.dpr, 0, Math.PI * 2);
    ctx.clip();

    // Draw in device pixels but with CSS-sized fonts via scale.
    // Pass undefined while loading so schematic shows "Loading detail…".
    ctx.save();
    ctx.translate(devCx, devCy);
    ctx.scale(layout.dpr, layout.dpr);
    paintMagnifierContent(ctx, 0, 0, rCss - 4, hit, detailObj);
    ctx.restore();

    ctx.restore();
  }

  return {
    onPointer,
    cancel,
    paint,
    setDetailBase,
    ensureDetail,
    get active() {
      return active;
    },
    get isOpen() {
      return !!active;
    },
  };
}
