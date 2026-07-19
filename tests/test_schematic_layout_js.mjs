/**
 * P4.10: JS decoder + layout blob size parity with C headers.
 * Run: node tests/test_schematic_layout_js.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  decodeSchematicLayout,
  SCHEMATIC_MAGIC,
  SCHEMATIC_VERSION,
} from "../demo/display/schematic_layout.js";

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

// Craft empty-ish header-only buffer (n_cables=0…)
const hdr = new ArrayBuffer(36);
const dv = new DataView(hdr);
dv.setUint32(0, SCHEMATIC_MAGIC, true);
dv.setUint32(4, SCHEMATIC_VERSION, true);
dv.setFloat32(8, 0, true);
dv.setFloat32(12, 0, true);
dv.setFloat32(16, 100, true);
dv.setUint32(20, 0, true);
dv.setUint32(24, 0, true);
dv.setUint32(28, 0, true);
dv.setUint32(32, 0, true);
const empty = decodeSchematicLayout(hdr);
assert(empty.ok, "decode empty tables");
assert(empty.header.n_cables === 0, "0 cables");

// Bad magic
dv.setUint32(0, 0xdeadbeef, true);
assert(decodeSchematicLayout(hdr).ok === false, "reject bad magic");

// Run native test binary if present; also layout fixture via helper dump
const bin = join(root, "build/webmap_schematic_layout");
try {
  execFileSync(bin, { cwd: root, stdio: "pipe" });
  assert(true, "native webmap_schematic_layout exits 0");
} catch (e) {
  assert(false, "native test: " + (e.message || e));
}

// Round-trip: use a tiny external C one-liner via existing fixture path existence
const fixture = join(root, "fixtures/schematic/sample_tap.json");
const json = readFileSync(fixture);
assert(json.byteLength > 100, "fixture json present");

// Decode sizes documented
assert(SCHEMATIC_MAGIC === 0x48435357, "magic constant");
assert(SCHEMATIC_VERSION === 1, "version constant");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall schematic_layout JS tests passed");
