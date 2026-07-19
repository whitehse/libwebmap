/**
 * Headless smoke for P4.7 weather package mapping (no WebGPU).
 * Run: node tests/test_weather_layer.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWeatherPackage,
  parseWeatherOpacityQuery,
  parseWeatherQuery,
  resolveWeatherStatus,
  statusRgba,
  STATUS_RGBA,
} from "../demo/display/weather_layer.js";

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

const fixture = JSON.parse(
  readFileSync(join(root, "fixtures/weather/sample_alerts.json"), "utf8")
);
const demoCopy = JSON.parse(
  readFileSync(join(root, "demo/weather/sample_alerts.json"), "utf8")
);

const p = parseWeatherPackage(fixture);
assert(p.ok, "parse sample package");
assert(p.features.length === 3, "three features in fixture");
assert(demoCopy.features?.length === 3, "demo/weather copy matches");

assert(resolveWeatherStatus("degraded") === "degraded", "status degraded");
assert(resolveWeatherStatus(undefined, "severe") === "down", "severity→down");
assert(resolveWeatherStatus(undefined, "minor") === "ok", "severity→ok");
assert(resolveWeatherStatus("nope") === "unknown", "unknown status");

const full = statusRgba("down", 1);
assert(full === STATUS_RGBA.down, "full opacity matches STATUS_RGBA");
const half = statusRgba("ok", 0.45);
assert((half & 0x00ffffff) === (STATUS_RGBA.ok & 0x00ffffff), "rgb preserved");
assert(((half >>> 24) & 0xff) === Math.round(0.45 * 255), "alpha 0.45");

assert(parseWeatherQuery("?weather=0") === false, "weather=0 off");
assert(parseWeatherQuery("?weather=1") === true, "weather=1 on");
assert(parseWeatherOpacityQuery("?weather_opacity=0.3") === 0.3, "opacity query");
assert(parseWeatherOpacityQuery("") === 0.45, "default opacity");

assert(parseWeatherPackage({ kind: "basemap" }).ok === false, "reject non-weather kind");

if (failed) {
  console.error(`\n${failed} failure(s)`);
  process.exit(1);
}
console.log("\nall weather_layer smoke tests passed");
