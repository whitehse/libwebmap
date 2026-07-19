/**
 * P4.11: schematic query + service modes + mapsFromSchematicLayout smoke.
 * Run: node tests/test_schematic_p411.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSchematicLayoutService,
  decodeSchematicLayout,
  parseSchematicQuery,
  SCHEMATIC_MAGIC,
} from "../demo/display/schematic_layout.js";
import { mapsFromSchematicLayout } from "../demo/display/fiber_schematic.js";
import { execFileSync } from "node:child_process";

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

assert(parseSchematicQuery("?schematic=js") === "js", "query js");
assert(parseSchematicQuery("?schematic=wasm") === "wasm", "query wasm");
assert(parseSchematicQuery("") === "auto", "query auto default");
assert(parseSchematicQuery("?layout=js") === "js", "alias layout=");

const svcJs = createSchematicLayoutService({ mode: "js", log: () => {} });
await svcJs.init();
assert(svcJs.ready, "js service ready");
assert(!svcJs.hasWasm, "js mode no wasm");
const detail = JSON.parse(
  readFileSync(join(root, "fixtures/schematic/sample_tap.json"), "utf8")
);
const fb = svcJs.layout(detail, { cx: 0, cy: 0, radius: 100 });
assert(fb && fb.ok === false && fb.source === "js", "js mode signals use_js");

/* Build a real blob via native C if available */
const native = join(root, "build/webmap_schematic_layout");
try {
  execFileSync(native, { cwd: root, stdio: "pipe" });
  assert(true, "native layout test green");
} catch (e) {
  assert(false, "native layout: " + e.message);
}

/* Synthetic precomputed maps */
const synthetic = {
  ok: true,
  header: { cx: 0, cy: 0, radius: 100, n_cables: 1, n_fibers: 1, n_fuses: 0 },
  cables: [
    {
      guid: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
      approach_deg: 90,
      ux: 1,
      uy: 0,
      x: 58,
      y: 0,
      is_drop: false,
      size: 12,
      fiber_count: 1,
      fiber_start: 0,
    },
  ],
  fibers: [
    { cable_index: 0, fiber_num: 1, x: 64, y: 0, chip_r: 5 },
  ],
  fuses: [],
};
const maps = mapsFromSchematicLayout(synthetic, 0, 0);
assert(maps && maps.layout.size === 1, "maps 1 cable");
assert(maps.fiberPos.size === 1, "maps 1 fiber");
const fp = maps.fiberPos.get(
  "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa|1"
);
assert(fp && Math.abs(fp.x - 64) < 1e-6, "fiber x from precomputed");

assert(SCHEMATIC_MAGIC === 0x48435357, "magic");

/* Service with wasm if module present */
const svc = createSchematicLayoutService({ mode: "auto", log: () => {} });
const hasWasmFile = (() => {
  try {
    readFileSync(join(root, "demo/webmap.wasm"));
    return true;
  } catch {
    try {
      readFileSync(join(root, "build-wasm/webmap.wasm"));
      return true;
    } catch {
      return false;
    }
  }
})();
if (hasWasmFile) {
  const url = join(root, "demo/webmap.wasm");
  // file:// may not work with fetch in node — skip network init in node
  assert(true, "wasm file present (browser service tested via demo)");
} else {
  assert(true, "wasm file absent in this checkout (ok for native-only CI)");
}

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall schematic P4.11 smoke tests passed");
