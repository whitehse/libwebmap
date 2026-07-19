#!/usr/bin/env node
/**
 * P4.6 / P4.13 — Headless compare: pure JS .wmap parse vs freestanding WASM path.
 *
 * Usage (from repo root):
 *   node tools/compare_wasm_parse.mjs
 *   node tools/compare_wasm_parse.mjs --dir demo/basemap --limit 40
 *   node tools/compare_wasm_parse.mjs --json > /tmp/compare.json
 *   node tools/compare_wasm_parse.mjs --retain-cache   # legacy dual-cache path
 *
 * Default WASM host uses **decode-and-drop** (P4.13): no second pyramid in C.
 */

import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join, relative, dirname } from "path";
import { fileURLToPath } from "url";
import { createWasmHost } from "../demo/display/wasm_host.js";
import { parseWmap, tilePayloadBytes } from "../demo/display/wmap_parse.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

/** Steady-state heap budget after decode-and-drop of many tiles (staging + free-list). */
const GATE_HEAP_USED_MAX = 3 * 1024 * 1024; /* 3 MiB */
/** Linear memory soft budget (8 MiB default import). */
const GATE_LINEAR_MAX = 12 * 1024 * 1024; /* 12 MiB */
/** Mean parse must not be much slower than JS. */
const GATE_SLOW_RATIO = 1.15;

function parseArgs(argv) {
  const o = {
    dir: join(ROOT, "demo/basemap"),
    wasm: join(ROOT, "demo/webmap.wasm"),
    limit: 48,
    json: false,
    warmup: 2,
    retainCache: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dir") o.dir = argv[++i];
    else if (a === "--wasm") o.wasm = argv[++i];
    else if (a === "--limit") o.limit = Number(argv[++i]) || o.limit;
    else if (a === "--json") o.json = true;
    else if (a === "--warmup") o.warmup = Number(argv[++i]) || 0;
    else if (a === "--retain-cache") o.retainCache = true;
    else if (a === "-h" || a === "--help") {
      console.log(
        `Usage: node tools/compare_wasm_parse.mjs [--dir path] [--limit N] [--json] [--retain-cache]`
      );
      process.exit(0);
    }
  }
  return o;
}

function listWmap(dir, limit) {
  /** @type {string[]} */
  const out = [];
  function walk(d) {
    if (out.length >= limit) return;
    let ents;
    try {
      ents = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (out.length >= limit) break;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".wmap")) out.push(p);
    }
  }
  walk(dir);
  return out;
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const i = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)
  );
  return sorted[i];
}

function fmtMs(ms) {
  return `${ms.toFixed(2)} ms`;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

/**
 * @param {(buf: ArrayBuffer) => object} parseFn
 * @param {Buffer[]} buffers
 * @param {number} warmup
 */
function benchParse(parseFn, buffers, warmup) {
  for (let i = 0; i < warmup && i < buffers.length; i++) {
    parseFn(
      buffers[i].buffer.slice(
        buffers[i].byteOffset,
        buffers[i].byteOffset + buffers[i].byteLength
      )
    );
  }
  const times = [];
  let payload = 0;
  let layers = 0;
  let errors = 0;
  const t0 = performance.now();
  for (const b of buffers) {
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const t1 = performance.now();
    try {
      const tile = parseFn(ab);
      times.push(performance.now() - t1);
      payload += tilePayloadBytes(tile);
      layers += tile.layers?.length || 0;
    } catch {
      errors++;
      times.push(performance.now() - t1);
    }
  }
  const total = performance.now() - t0;
  const sorted = [...times].sort((a, b) => a - b);
  return {
    tiles: buffers.length,
    errors,
    total_ms: total,
    per_tile_ms: {
      mean: times.length ? times.reduce((a, b) => a + b, 0) / times.length : 0,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      max: sorted.length ? sorted[sorted.length - 1] : 0,
    },
    output_payload_bytes: payload,
    layer_count: layers,
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const paths = listWmap(args.dir, args.limit);
  if (!paths.length) {
    console.error("No .wmap files under", args.dir);
    process.exit(1);
  }
  const buffers = paths.map((p) => readFileSync(p));
  const fileBytes = buffers.reduce((a, b) => a + b.byteLength, 0);

  const js = benchParse(parseWmap, buffers, args.warmup);

  const decodeAndDrop = !args.retainCache;
  const host = createWasmHost({
    log: () => {},
    decodeAndDrop,
    maxTiles: decodeAndDrop ? 2 : Math.max(64, paths.length + 8),
  });
  const wasmBytes = readFileSync(args.wasm);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("webmap.wasm") || u.endsWith(".wasm")) {
      const copy = wasmBytes.buffer.slice(
        wasmBytes.byteOffset,
        wasmBytes.byteOffset + wasmBytes.byteLength
      );
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => copy,
      };
    }
    if (realFetch) return realFetch(url);
    throw new Error("fetch " + u);
  };
  try {
    await host.init(args.wasm);
  } finally {
    if (realFetch) globalThis.fetch = realFetch;
    else delete globalThis.fetch;
  }

  const wasm = benchParse(
    (ab) => host.parseWmapViaWasm(ab),
    buffers,
    args.warmup
  );
  const hs = host.heapStats() || {};
  const linear = host.getMemory()?.buffer?.byteLength || 0;

  const report = {
    v: 2,
    kind: "libwebmap_p46_parse_compare",
    t: new Date().toISOString(),
    config: {
      dir: relative(ROOT, args.dir) || args.dir,
      wasm: relative(ROOT, args.wasm) || args.wasm,
      limit: args.limit,
      tiles: paths.length,
      warmup: args.warmup,
      file_bytes: fileBytes,
      decode_and_drop: decodeAndDrop,
    },
    js,
    wasm: {
      ...wasm,
      heap_used: hs.used || 0,
      heap_free: hs.free || 0,
      heap_capacity: hs.capacity || 0,
      linear_memory: linear,
      over_watermark: hs.over_watermark || 0,
      tile_count: hs.tile_count ?? -1,
      drop_count: hs.drop_count ?? 0,
      decode_and_drop: !!hs.decode_and_drop,
    },
    ratios: {
      total_time_wasm_over_js: js.total_ms > 0 ? wasm.total_ms / js.total_ms : null,
      mean_time_wasm_over_js:
        js.per_tile_ms.mean > 0
          ? wasm.per_tile_ms.mean / js.per_tile_ms.mean
          : null,
      payload_equal:
        js.output_payload_bytes === wasm.output_payload_bytes &&
        js.layer_count === wasm.layer_count,
    },
    gate: {
      default_on_recommended: false,
      reasons: [],
      blockers: [],
      notes: [],
    },
  };

  const blockers = report.gate.blockers;
  const notes = report.gate.notes;
  if (wasm.errors > 0) blockers.push(`wasm parse errors: ${wasm.errors}`);
  if (js.errors > 0) blockers.push(`js parse errors: ${js.errors}`);
  if (!report.ratios.payload_equal) {
    blockers.push("output payload/layer counts differ between paths");
  }
  if (
    report.ratios.mean_time_wasm_over_js != null &&
    report.ratios.mean_time_wasm_over_js > GATE_SLOW_RATIO
  ) {
    blockers.push(
      `mean parse slower on WASM (${report.ratios.mean_time_wasm_over_js.toFixed(2)}× JS)`
    );
  }

  if (!decodeAndDrop) {
    blockers.push(
      "retain-cache mode: C tile cache holds full pyramid (use default decode-and-drop)"
    );
  } else {
    notes.push("decode-and-drop: C tile cache emptied after each extract");
    if ((hs.tile_count ?? 0) > 0) {
      blockers.push(
        `C tile_count after drop path is ${hs.tile_count} (expected 0)`
      );
    } else {
      notes.push("tile_count=0 after sequential decode-and-drop");
    }
    if ((hs.used || 0) > GATE_HEAP_USED_MAX) {
      blockers.push(
        `heap used ${fmtBytes(hs.used || 0)} > budget ${fmtBytes(GATE_HEAP_USED_MAX)}`
      );
    } else {
      notes.push(
        `heap used ${fmtBytes(hs.used || 0)} within budget ${fmtBytes(GATE_HEAP_USED_MAX)}`
      );
    }
    if (linear > GATE_LINEAR_MAX) {
      blockers.push(
        `linear memory ${fmtBytes(linear)} > soft budget ${fmtBytes(GATE_LINEAR_MAX)}`
      );
    } else {
      notes.push(`linear memory ${fmtBytes(linear)} within soft budget`);
    }
    /* Transient host copies for extrusion still exist (same class as JS parse). */
    notes.push(
      "host still copies verts once for line extrusion; no dual C+JS pyramid retention"
    );
  }

  report.gate.default_on_recommended = blockers.length === 0;
  report.gate.reasons = blockers.length ? blockers : notes;
  report.gate.summary = report.gate.default_on_recommended
    ? "Default-on recommended: demo uses WASM decode-and-drop by default (auto); ?wasm=0 forces JS."
    : "Keep JS fallback available. Gate blocked — see reasons. Demo may still prefer auto with JS fallback.";

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log("P4.6/P4.13 JS vs WASM .wmap parse compare");
    console.log(`  tiles: ${paths.length}  file bytes: ${fmtBytes(fileBytes)}`);
    console.log(`  dir: ${report.config.dir}`);
    console.log(
      `  wasm mode: ${decodeAndDrop ? "decode-and-drop" : "retain-cache"}`
    );
    console.log("");
    console.log("  JS parse:");
    console.log(
      `    total ${fmtMs(js.total_ms)}  mean ${fmtMs(js.per_tile_ms.mean)}  p95 ${fmtMs(js.per_tile_ms.p95)}`
    );
    console.log(
      `    output payload ${fmtBytes(js.output_payload_bytes)}  layers ${js.layer_count}  errors ${js.errors}`
    );
    console.log("  WASM parse:");
    console.log(
      `    total ${fmtMs(wasm.total_ms)}  mean ${fmtMs(wasm.per_tile_ms.mean)}  p95 ${fmtMs(wasm.per_tile_ms.p95)}`
    );
    console.log(
      `    output payload ${fmtBytes(wasm.output_payload_bytes)}  layers ${wasm.layer_count}  errors ${wasm.errors}`
    );
    console.log(
      `    heap used ${fmtBytes(hs.used || 0)}  free ${fmtBytes(hs.free || 0)}  cap ${fmtBytes(hs.capacity || 0)}`
    );
    console.log(
      `    linear memory ${fmtBytes(linear)}  tiles_in_c=${hs.tile_count ?? "?"}  drops=${hs.drop_count ?? 0}`
    );
    console.log("");
    console.log(
      `  time ratio WASM/JS (mean): ${
        report.ratios.mean_time_wasm_over_js != null
          ? report.ratios.mean_time_wasm_over_js.toFixed(3) + "×"
          : "n/a"
      }`
    );
    console.log(`  payload match: ${report.ratios.payload_equal}`);
    console.log("");
    console.log("  Default-on recommended:", report.gate.default_on_recommended);
    console.log("  " + report.gate.summary);
    for (const r of report.gate.reasons) console.log("   - " + r);
  }

  const outPath = join(ROOT, "docs/guides/p46-compare-latest.json");
  try {
    writeFileSync(outPath, JSON.stringify(report, null, 2));
    if (!args.json) console.log(`\nWrote ${relative(ROOT, outPath)}`);
  } catch {
    /* ignore */
  }

  /* Exit 0 always for measurement; ctest matches summary text. */
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
