/**
 * Headless smoke for P4.8 glass tokens (CSS/JS parity samples).
 * Run: node tests/test_glass_tokens.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  GLASS_CSS_VARS,
  GLASS_LENS,
  GLASS_STATUS,
  GLASS_TOKENS_VERSION,
} from "../demo/display/glass_tokens.js";
import {
  MAG_BG,
  MAG_RIM,
  MAG_RIM_INNER,
  MAG_SOURCE,
  MAG_THROUGH,
} from "../demo/display/fiber_style.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "demo/display/glass_ui.css"), "utf8");
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
}

assert(typeof GLASS_TOKENS_VERSION === "string" && GLASS_TOKENS_VERSION.length > 0, "version set");
assert(MAG_BG === GLASS_LENS.bg, "MAG_BG from GLASS_LENS");
assert(MAG_RIM === GLASS_LENS.rim, "MAG_RIM from GLASS_LENS");
assert(MAG_RIM_INNER === GLASS_LENS.rimInner, "MAG_RIM_INNER from GLASS_LENS");
assert(MAG_SOURCE === GLASS_LENS.source, "MAG_SOURCE from GLASS_LENS");
assert(MAG_THROUGH === GLASS_LENS.through, "MAG_THROUGH from GLASS_LENS");

assert(css.includes("--glass-rim:"), "css defines --glass-rim");
assert(css.includes("--glass-bg-lens:"), "css defines --glass-bg-lens");
assert(css.includes(".glass-float"), "css has .glass-float");
assert(css.includes(".glass-hud"), "css has .glass-hud");
assert(css.includes("prefers-reduced-transparency"), "a11y reduced transparency");

// Sample parity: CSS file contains the same rim string as JS
assert(css.includes(GLASS_LENS.rim), "css contains GLASS_LENS.rim value");
assert(css.includes(GLASS_LENS.bg), "css contains GLASS_LENS.bg value");
assert(
  css.includes(GLASS_STATUS.ok.css) || css.includes("--glass-status-ok"),
  "css status-ok token"
);

assert(GLASS_CSS_VARS["--glass-rim"] === GLASS_LENS.rim, "CSS_VARS rim matches lens");
assert(GLASS_STATUS.down.rgba === 0xffe74c3c, "status down packed rgba");
assert(GLASS_STATUS.ok.css === "#2ecc71", "status ok hex");

const index = readFileSync(join(root, "demo/index.html"), "utf8");
assert(index.includes("glass_ui.css"), "index links glass_ui.css");
assert(index.includes("glass-app"), "index uses glass-app");
assert(index.includes("glass-shell"), "index uses glass-shell");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall glass_tokens smoke tests passed");
