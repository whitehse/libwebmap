/**
 * Headless smoke for P4.9 dynamic_feed (no WebGPU / no WS).
 * Run: node tests/test_dynamic_feed.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALLOWED_NS,
  NOTIFY_MAX_PAYLOAD,
  parseDynamicMessage,
  parseFeedQuery,
  parseJsonlEvents,
} from "../demo/display/dynamic_feed.js";

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

assert(ALLOWED_NS.includes("map.dynamic"), "allowlist map.dynamic");
assert(NOTIFY_MAX_PAYLOAD === 8000, "max payload 8000");

const good = parseDynamicMessage({
  v: 1,
  op: "upsert",
  ns: "map.dynamic",
  key: "feature/fiber/span-1",
  value: { id: "span-1", class: "fiber", status: "down" },
});
assert(good.ok && good.msg.op === "upsert", "upsert ok");
assert(good.msg.value.status === "down", "value preserved");

const put = parseDynamicMessage({
  v: 1,
  op: "put",
  ns: "map.dynamic",
  key: "feature/a",
  value: { id: "a", status: "ok" },
});
assert(put.ok && put.msg.op === "upsert", "put → upsert");

const rem = parseDynamicMessage({
  v: 1,
  op: "remove",
  ns: "map.dynamic",
  key: "feature/a",
});
assert(rem.ok && rem.msg.op === "remove", "remove ok");

const badNs = parseDynamicMessage({
  v: 1,
  op: "upsert",
  ns: "net.core",
  key: "router/x",
  value: { id: "x", status: "ok" },
});
assert(!badNs.ok && badNs.reason === "ns", "drop net.core");

const badV = parseDynamicMessage({
  v: 2,
  op: "upsert",
  ns: "map.dynamic",
  key: "k",
  value: { id: "k", status: "ok" },
});
assert(!badV.ok && badV.reason === "version", "drop v≠1");

const badJson = parseDynamicMessage("{not json");
assert(!badJson.ok && badJson.reason === "json", "drop bad json");

const huge = parseDynamicMessage(
  JSON.stringify({
    v: 1,
    op: "upsert",
    ns: "map.dynamic",
    key: "k",
    value: { id: "k", status: "ok", pad: "x".repeat(9000) },
  })
);
assert(!huge.ok && huge.reason === "too_large", "drop oversized");

const wsEnv = parseDynamicMessage({
  type: "STATE_CHANGED",
  ns: "map.dynamic",
  key: "feature/fiber/span-1",
  op: "put",
  value: { id: "span-1", status: "maint" },
  request_id: "01JTEST",
});
assert(wsEnv.ok && wsEnv.msg.source === "state_changed", "STATE_CHANGED");
assert(wsEnv.msg.op === "upsert" && wsEnv.msg.value.status === "maint", "WS put");

const qOff = parseFeedQuery("?feed=0");
assert(qOff.enabled === false && qOff.mode === "off", "feed=0");
const qDef = parseFeedQuery("");
assert(qDef.mode === "fixture" && qDef.url.includes("sample_events"), "default fixture");
const qWs = parseFeedQuery("?feed=ws://127.0.0.1:9/stream");
assert(qWs.mode === "ws" && qWs.url.startsWith("ws://"), "ws feed");
const qIv = parseFeedQuery("?feed_interval=0");
assert(qIv.intervalMs === 0, "feed_interval");

const fixture = readFileSync(
  join(root, "fixtures/dynamic/sample_events.jsonl"),
  "utf8"
);
const lines = parseJsonlEvents(fixture);
assert(lines.length >= 7, "fixture has events");
const okLines = lines.filter((l) => l.result.ok);
const dropLines = lines.filter((l) => !l.result.ok);
assert(okLines.length >= 5, "several good lines");
assert(dropLines.length >= 2, "net.core + bad version dropped");

const demoCopy = readFileSync(
  join(root, "demo/dynamic/sample_events.jsonl"),
  "utf8"
);
assert(demoCopy.includes("span-demo-1"), "demo fixture present");

const envelope = readFileSync(
  join(root, "fixtures/dynamic/sample_ws_envelope.jsonl"),
  "utf8"
);
const envParsed = parseDynamicMessage(envelope.trim());
assert(envParsed.ok, "sample WS envelope parses");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall dynamic_feed smoke tests passed");
