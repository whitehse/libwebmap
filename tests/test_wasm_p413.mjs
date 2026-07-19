/**
 * Headless smoke for P4.13 WASM default / decode-and-drop.
 * Run: node tests/test_wasm_p413.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWasmHost,
  parseWasmQuery,
  wasmQueryWantsModule,
} from "../demo/display/wasm_host.js";
import { parseWmap, tilePayloadBytes } from "../demo/display/wmap_parse.js";

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

assert(parseWasmQuery("") === "auto", "default auto");
assert(parseWasmQuery("?") === "auto", "empty query auto");
assert(parseWasmQuery("?foo=1") === "auto", "unrelated auto");
assert(parseWasmQuery("?wasm=1") === "on", "wasm=1 on");
assert(parseWasmQuery("?wasm=true") === "on", "wasm=true on");
assert(parseWasmQuery("?wasm=0") === "off", "wasm=0 off");
assert(parseWasmQuery("?wasm=js") === "off", "wasm=js off");
assert(parseWasmQuery("?wasm=auto") === "auto", "wasm=auto");
assert(wasmQueryWantsModule("?wasm=0") === false, "wants off");
assert(wasmQueryWantsModule("") === true, "wants auto");

const main = readFileSync(join(root, "demo/main.js"), "utf8");
assert(main.includes("wasmMode"), "main uses wasmMode");
assert(main.includes("decodeAndDrop"), "main decodeAndDrop");
assert(main.includes("wantWasmBasemap"), "main wantWasmBasemap");

const hdr = readFileSync(join(root, "include/webmap.h"), "utf8");
assert(hdr.includes("webmap_drop_tile"), "public drop_tile API");

const entry = readFileSync(join(root, "wasm/webmap_wasm_entry.c"), "utf8");
assert(entry.includes('export_name("webmap_drop_tile")'), "wasm export drop");
assert(entry.includes('export_name("webmap_tile_count")'), "wasm export count");

/* Live WASM decode-and-drop if module present */
const wasmPath = join(root, "demo/webmap.wasm");
let wasmBytes;
try {
  wasmBytes = readFileSync(wasmPath);
} catch {
  wasmBytes = null;
}

async function live() {
  if (!wasmBytes) {
    console.log("skip: demo/webmap.wasm missing (rebuild WASM target)");
    return;
  }

  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).includes("webmap.wasm") || String(url).endsWith(".wasm")) {
      const copy = wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength
      );
      return { ok: true, status: 200, arrayBuffer: async () => copy };
    }
    throw new Error("unexpected fetch " + url);
  };

  try {
    const host = createWasmHost({ log: () => {}, decodeAndDrop: true });
    await host.init(wasmPath);
    assert(host.ready, "host ready");
    assert(host.decodeAndDrop === true, "decodeAndDrop flag");

    /* Pick a small basemap tile if present */
    const sample = join(root, "demo/basemap/10/238/401.wmap");
    let buf;
    try {
      buf = readFileSync(sample);
    } catch {
      console.log("skip live tile: sample basemap missing");
      return;
    }
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const jsTile = parseWmap(ab);
    const wasmTile = host.parseWmapViaWasm(ab);
    assert(jsTile.layers.length === wasmTile.layers.length, "layer count match");
    assert(
      tilePayloadBytes(jsTile) === tilePayloadBytes(wasmTile),
      "payload bytes match"
    );
    const hs = host.heapStats();
    assert(hs.tile_count === 0, "tile_count 0 after drop");
    assert(hs.drop_count >= 1, "drop_count >= 1");
    assert(hs.used < 3 * 1024 * 1024, "heap used under 3 MiB after one tile");
  } finally {
    if (realFetch) globalThis.fetch = realFetch;
    else delete globalThis.fetch;
  }
}

await live();

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall wasm P4.13 smoke tests passed");
