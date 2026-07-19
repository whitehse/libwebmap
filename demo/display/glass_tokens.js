/**
 * Glass UI tokens for Canvas2D / JS hosts (P4.8 / ADR-021).
 *
 * Keep in sync with demo/display/glass_ui.css :root custom properties.
 * Documented in docs/guides/glass-ui.md.
 */

/** CSS custom-property names → values (for docs / runtime injection). */
export const GLASS_CSS_VARS = {
  "--glass-bg-deep": "#0b1220",
  "--glass-bg-map": "#0e1626",
  "--glass-bg-header": "#121a2b",
  "--glass-bg-panel": "rgba(16, 24, 42, 0.88)",
  "--glass-bg-panel-solid": "#10182a",
  "--glass-bg-elevated-solid": "#1a2740",
  "--glass-bg-inset": "#0c1424",
  "--glass-bg-hover": "#243656",
  "--glass-bg-lens": "rgba(12, 16, 24, 0.94)",
  "--glass-border": "#2a3d5c",
  "--glass-border-strong": "#334a6d",
  "--glass-rim": "rgba(160, 200, 255, 0.55)",
  "--glass-rim-inner": "rgba(255, 255, 255, 0.12)",
  "--glass-rim-tick": "rgba(255, 255, 255, 0.35)",
  "--glass-text": "#e8eef7",
  "--glass-text-secondary": "#9ab0d0",
  "--glass-text-muted": "#9aa7b5",
  "--glass-text-accent": "#9ec5ff",
  "--glass-text-code": "#c8e0ff",
  "--glass-text-lens": "#e7ecf1",
  "--glass-accent": "#ffc800",
  "--glass-accent-soft": "#2a3018",
  "--glass-source": "#7dffa0",
  "--glass-through": "#f0a030",
  "--glass-through-glow": "rgba(240, 160, 48, 0.35)",
  "--glass-mainline": "#6ab0ff",
  "--glass-fuse": "#5dade2",
  "--glass-tap": "#e67e22",
  "--glass-drop": "#c0392b",
  "--glass-drop-fill": "rgba(192, 57, 59, 0.12)",
  "--glass-splice": "#7eb6ff",
  "--glass-hint": "#6b7785",
  "--glass-status-unknown": "#95a5a6",
  "--glass-status-ok": "#2ecc71",
  "--glass-status-degraded": "#f1c40f",
  "--glass-status-down": "#e74c3c",
  "--glass-status-maint": "#3498db",
  "--glass-shadow": "0 6px 24px rgba(0, 0, 0, 0.35)",
  "--glass-blur": "14px",
  "--glass-radius-sm": "4px",
  "--glass-radius-md": "8px",
};

/**
 * Canvas2D / schematic chrome (magnifier lens).
 * Values match --glass-* and historical MAG_* names.
 */
export const GLASS_LENS = {
  bg: "rgba(12, 16, 24, 0.94)",
  rim: "rgba(160, 200, 255, 0.55)",
  rimInner: "rgba(255, 255, 255, 0.12)",
  rimTick: "rgba(255, 255, 255, 0.35)",
  shadow: "rgba(0, 0, 0, 0.35)",
  text: "#e7ecf1",
  muted: "#9aa7b5",
  tap: "#e67e22",
  drop: "#c0392b",
  dropFill: "rgba(192, 57, 59, 0.12)",
  splice: "#7eb6ff",
  mainline: "#6ab0ff",
  fuse: "#5dade2",
  hint: "#6b7785",
  through: "#f0a030",
  throughGlow: "rgba(240, 160, 48, 0.35)",
  source: "#7dffa0",
};

/**
 * Status colors as CSS hex (for DOM) and packed 0xAABBGGRR (for WebGPU).
 * Matches webmap_status_rgba in src/webmap.c.
 */
export const GLASS_STATUS = {
  unknown: { css: "#95a5a6", rgba: 0xff95a5a6 },
  ok: { css: "#2ecc71", rgba: 0xff2ecc71 },
  degraded: { css: "#f1c40f", rgba: 0xfff1c40f },
  down: { css: "#e74c3c", rgba: 0xffe74c3c },
  maint: { css: "#3498db", rgba: 0xff3498db },
};

/**
 * Optional: inject missing CSS vars onto documentElement (for hosts that
 * load tokens without glass_ui.css). No-op if already defined.
 * @param {CSSStyleDeclaration|null} [style]
 */
export function applyGlassCssVars(style = null) {
  const target =
    style ||
    (typeof document !== "undefined" ? document.documentElement.style : null);
  if (!target) return;
  for (const [k, v] of Object.entries(GLASS_CSS_VARS)) {
    if (!target.getPropertyValue(k)?.trim()) {
      target.setProperty(k, v);
    }
  }
}

/** Token set version for A/B snapshots / docs. */
export const GLASS_TOKENS_VERSION = "1.0.0";
