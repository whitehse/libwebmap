/**
 * Headless smoke for P4.12 WebGPU glass lens helpers (no GPU required).
 * Run: node tests/test_glass_lens_gpu.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCssColorRgba,
  parseGlassGpuQuery,
} from "../demo/display/glass_lens_gpu.js";
import { GLASS_LENS } from "../demo/display/glass_tokens.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function assert(cond, msg) {
  if (!cond) {
    console.error("FAIL:", msg);
    failed++;
  } else {
    console.log("ok:", msg);
  }
}

assert(parseGlassGpuQuery("") === false, "default off");
assert(parseGlassGpuQuery("?foo=1") === false, "unrelated query off");
assert(parseGlassGpuQuery("?glass_gpu=1") === true, "glass_gpu=1");
assert(parseGlassGpuQuery("?glass_gpu=true") === true, "glass_gpu=true");
assert(parseGlassGpuQuery("?glass_gpu=0") === false, "glass_gpu=0");
assert(parseGlassGpuQuery("?glassgpu=on") === true, "alias glassgpu=on");
assert(parseGlassGpuQuery("?schematic=wasm&glass_gpu=1") === true, "combined");

const rim = parseCssColorRgba(GLASS_LENS.rim);
assert(rim.length === 4, "rim rgba 4");
assert(rim[0] > 0.5 && rim[2] > 0.5, "rim is bluish");
assert(rim[3] > 0.4 && rim[3] <= 1, "rim alpha mid");

const bg = parseCssColorRgba(GLASS_LENS.bg);
assert(bg[3] > 0.8, "lens bg mostly opaque");

const hex = parseCssColorRgba("#2ecc71");
assert(Math.abs(hex[0] - 0x2e / 255) < 0.01, "hex r");
assert(Math.abs(hex[1] - 0xcc / 255) < 0.01, "hex g");

const bad = parseCssColorRgba("not-a-color", [0.1, 0.2, 0.3, 0.4]);
assert(bad[0] === 0.1 && bad[3] === 0.4, "fallback color");

const src = readFileSync(join(root, "demo/display/glass_lens_gpu.js"), "utf8");
assert(src.includes("createGlassLensGpu"), "exports createGlassLensGpu");
assert(src.includes("sd_circle") || src.includes("length(p)"), "SDF distance");
assert(src.includes("@fragment"), "has fragment shader");

const main = readFileSync(join(root, "demo/main.js"), "utf8");
assert(main.includes("parseGlassGpuQuery"), "main imports query parser");
assert(main.includes("createGlassLensGpu"), "main creates GPU lens");
assert(main.includes("glass:gpu"), "status shows glass:gpu");

const mag = readFileSync(join(root, "demo/display/fiber_magnifier.js"), "utf8");
assert(mag.includes('chrome === "gpu"') || mag.includes('chrome: "gpu"') || mag.includes('opts.chrome'), "magnifier chrome modes");
assert(mag.includes("getLensLayout"), "exposes getLensLayout");

const adr = readFileSync(join(root, "docs/decisions/027-webgpu-glass-lens.md"), "utf8");
assert(adr.includes("P4.12"), "ADR-027 mentions P4.12");
assert(adr.includes("glass_gpu"), "ADR documents query param");

const guide = readFileSync(join(root, "docs/guides/glass-ui.md"), "utf8");
assert(guide.includes("glass_gpu"), "guide documents glass_gpu");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall glass_lens_gpu smoke tests passed");
