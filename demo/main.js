/**
 * libwebmap WebGPU host demo.
 * Basemap: .wmap (Shortbread). Fiber: data-only .fmap + demo/display/ layer.
 * Features: extruded roads/water with miter joins, LOD, smooth wheel zoom,
 * overzoom past tile max.
 */

import { createFiberLayer } from "./display/fiber_layer.js";

const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("c");
const labelCanvas = document.getElementById("labels");
const labelCtx = labelCanvas ? labelCanvas.getContext("2d") : null;

function log(msg) {
  logEl.textContent += msg + "\n";
  logEl.scrollTop = logEl.scrollHeight;
  console.log(msg);
}

function setStatus(html) {
  statusEl.innerHTML = html;
}

/* ── Shortbread schema style (VersaTiles Colorful) ───────────────────
 * Layers + `kind` follow https://shortbread-tiles.org/schema/1.0/
 * Paint defaults from versatiles-org/versatiles-style Colorful.
 * .wmap layer names are `layer` or `layer/kind` after MVT conversion.
 */

/** #RRGGBB → packed 0xAABBGGRR */
function hex(rgb, a = 0xff) {
  const r = (rgb >> 16) & 0xff;
  const g = (rgb >> 8) & 0xff;
  const b = rgb & 0xff;
  return ((a & 0xff) << 24) | (b << 16) | (g << 8) | r;
}

const C = {
  land: 0xf9f4ee,
  water: 0xbeddf3,
  glacier: 0xffffff,
  wood: 0x66aa44,
  grass: 0xd8e8c8,
  park: 0xd9d9a5,
  street: 0xffffff,
  streetbg: 0xcfcdca,
  motorway: 0xffcc88,
  motorwaybg: 0xe9ac77,
  trunk: 0xffeeaa,
  trunkbg: 0xe9ac77,
  building: 0xf2eae2,
  buildingbg: 0xdfdbd7,
  boundary: 0xa6a6c8,
  residential: 0xeae6e1,
  commercial: 0xf7deed,
  industrial: 0xfff4c2,
  foot: 0xfbebff,
  agriculture: 0xf0e7d1,
  rail: 0xb1bbc4,
  waste: 0xdbd6bd,
  burial: 0xdddbca,
  sand: 0xfafaed,
  rock: 0xe0e4e5,
  leisure: 0xe7edde,
  wetland: 0xd3e6db,
};

const STYLE = {
  background: { r: 0xF9 / 255, g: 0xF4 / 255, b: 0xEE / 255, a: 1 },
};

function splitLayerKind(name) {
  const i = name.indexOf("/");
  if (i < 0) return { layer: name, kind: "" };
  return { layer: name.slice(0, i), kind: name.slice(i + 1) };
}

/** Interpolate MapLibre-style zoom stops: {z: width, ...} */
function zoomStops(stops, zoom) {
  const zs = Object.keys(stops)
    .map(Number)
    .sort((a, b) => a - b);
  if (!zs.length) return 0;
  if (zoom <= zs[0]) return stops[zs[0]];
  if (zoom >= zs[zs.length - 1]) return stops[zs[zs.length - 1]];
  for (let i = 0; i < zs.length - 1; i++) {
    const z0 = zs[i];
    const z1 = zs[i + 1];
    if (zoom >= z0 && zoom <= z1) {
      const t = (zoom - z0) / (z1 - z0);
      return stops[z0] + (stops[z1] - stops[z0]) * t;
    }
  }
  return stops[zs[zs.length - 1]];
}

/**
 * Line width (full CSS px) + casing ratio by Shortbread street kind.
 * Stops simplified from VersaTiles Colorful street-* rules.
 */
function streetPaint(kind) {
  const k = kind || "residential";
  const link = k.endsWith("_link");
  const base = link ? k.replace(/_link$/, "") : k;

  if (base === "motorway") {
    return {
      color: hex(C.motorway),
      casing: hex(C.motorwaybg),
      width: { 5: 1, 6: 1, 10: 4, 14: 4, 16: 12, 18: 28 },
      casingScale: 1.35,
      order: 68,
    };
  }
  if (base === "trunk" || base === "primary") {
    return {
      color: hex(C.trunk),
      casing: hex(C.trunkbg),
      width: { 7: 1, 10: 3, 14: 5, 16: 10, 18: 24 },
      casingScale: 1.35,
      order: 66,
    };
  }
  if (base === "secondary") {
    return {
      color: hex(C.trunk),
      casing: hex(C.trunkbg),
      width: { 11: 1, 14: 4, 16: 6, 18: 20 },
      casingScale: 1.35,
      order: 65,
    };
  }
  if (
    base === "tertiary" ||
    base === "unclassified" ||
    base === "residential" ||
    base === "living_street" ||
    base === "livingstreet" ||
    base === "pedestrian"
  ) {
    return {
      color: hex(C.street),
      casing: hex(C.streetbg),
      width: { 12: 1, 14: 2, 16: 5, 18: 16 },
      casingScale: 1.4,
      order: 63,
    };
  }
  if (base === "service" || base === "track") {
    return {
      color: hex(C.street),
      casing: hex(C.streetbg),
      width: { 14: 1, 16: 3, 18: 10 },
      casingScale: 1.4,
      order: 62,
    };
  }
  if (
    base === "rail" ||
    base === "narrow_gauge" ||
    base === "light_rail" ||
    base === "subway" ||
    base === "tram" ||
    base === "monorail"
  ) {
    return {
      color: hex(C.rail),
      casing: hex(0x8a939c),
      width: { 8: 1, 14: 1.5, 16: 2, 18: 4 },
      casingScale: 1.5,
      order: 61,
    };
  }
  if (base === "runway") {
    return {
      color: hex(C.street),
      casing: hex(C.streetbg),
      width: { 11: 2, 12: 5, 14: 12, 16: 28 },
      casingScale: 1.15,
      order: 64,
    };
  }
  if (base === "taxiway") {
    return {
      color: hex(C.street),
      casing: hex(C.streetbg),
      width: { 13: 1, 14: 2, 16: 8, 18: 14 },
      casingScale: 1.2,
      order: 63,
    };
  }
  if (
    base === "footway" ||
    base === "path" ||
    base === "steps" ||
    base === "cycleway" ||
    base === "bridleway"
  ) {
    return {
      color: hex(C.foot),
      casing: hex(0xe0d0e8),
      width: { 14: 0.8, 16: 1.5, 18: 3 },
      casingScale: 1.5,
      order: 60,
    };
  }
  return {
    color: hex(C.street),
    casing: hex(C.streetbg),
    width: { 12: 1, 14: 2, 16: 4, 18: 12 },
    casingScale: 1.4,
    order: 62,
  };
}

function landColor(kind) {
  switch (kind) {
    case "forest":
    case "wood":
      return hex(C.wood);
    case "grass":
    case "grassland":
    case "meadow":
    case "village_green":
    case "recreation_ground":
    case "heath":
    case "scrub":
      return hex(C.grass);
    case "park":
    case "golf_course":
      return hex(C.park);
    case "orchard":
    case "vineyard":
    case "farmland":
    case "farmyard":
    case "allotments":
    case "greenhouse_horticulture":
    case "plant_nursery":
    case "greenfield":
      return hex(C.agriculture);
    case "residential":
      return hex(C.residential, 0x55);
    case "commercial":
    case "retail":
      return hex(C.commercial, 0x50);
    case "industrial":
    case "railway":
    case "brownfield":
      return hex(C.industrial, 0x60);
    case "landfill":
      return hex(C.waste);
    case "cemetery":
    case "grave_yard":
      return hex(C.burial);
    case "sand":
    case "beach":
      return hex(C.sand);
    case "bare_rock":
    case "scree":
    case "shingle":
      return hex(C.rock);
    case "swamp":
    case "bog":
    case "string_bog":
    case "wet_meadow":
    case "wetland":
    case "marsh":
      return hex(C.wetland);
    default:
      return hex(0xf4efe6);
  }
}

function styleColor(name, baked) {
  const { layer, kind } = splitLayerKind(name);
  /* Fiber paint is handled by demo/display/ (feature data + style). */
  if (layer === "fiber") {
    return baked;
  }
  if (layer === "ocean" || layer === "water" || layer === "water_polygons") {
    return kind === "glacier" ? hex(C.glacier) : hex(C.water);
  }
  if (layer === "water_lines" || layer === "waterway") {
    return kind === "stream" || kind === "ditch"
      ? hex(0xa8d4f0)
      : hex(0x9ccbea);
  }
  if (
    layer === "dam_lines" ||
    layer === "dam_polygons" ||
    layer === "pier_lines" ||
    layer === "pier_polygons"
  ) {
    return hex(C.land);
  }
  if (layer === "land" || layer === "landcover" || layer === "landuse") {
    return landColor(kind);
  }
  if (layer === "building" || layer === "buildings") {
    return hex(C.building);
  }
  if (layer === "bridges" || layer === "bridge") {
    return hex(C.land, 0xcc);
  }
  if (layer === "sites") {
    return hex(C.leisure, 0xa0);
  }
  if (
    layer === "streets" ||
    layer === "street_polygons" ||
    layer === "transportation" ||
    layer === "road" ||
    layer === "highway"
  ) {
    return streetPaint(kind).color;
  }
  if (layer === "boundaries" || layer === "boundary") {
    return hex(C.boundary);
  }
  if (layer === "public_transport" || layer === "pois") {
    return hex(0x66626a);
  }
  return baked;
}

function styleOrder(name) {
  const { layer, kind } = splitLayerKind(name);
  if (layer === "land" || layer === "landcover" || layer === "landuse") {
    // darker greens under residential tints
    if (kind === "forest" || kind === "wood") return 12;
    if (kind === "residential") return 18;
    if (kind === "industrial" || kind === "commercial" || kind === "retail")
      return 17;
    return 15;
  }
  if (layer === "sites") return 22;
  if (layer === "building" || layer === "buildings") return 30;
  if (layer === "bridges" || layer === "bridge") return 35;
  if (layer === "water_polygons" || layer === "water" || layer === "ocean")
    return 40;
  if (layer === "water_lines" || layer === "waterway") return 50;
  if (layer === "dam_lines" || layer === "pier_lines") return 52;
  if (
    layer === "streets" ||
    layer === "street_polygons" ||
    layer === "transportation" ||
    layer === "road" ||
    layer === "highway"
  ) {
    return streetPaint(kind).order;
  }
  if (layer === "boundaries" || layer === "boundary") return 75;
  if (layer === "public_transport" || layer === "pois") return 80;
  if (layer === "overlay") return 100;
  return 55;
}

function styleLineWidth(name, zoom) {
  const { layer, kind } = splitLayerKind(name.replace(/_casing$/, ""));
  if (layer === "fiber") {
    /* Fiber widths: demo/display/fiber_style.js */
    return zoomStops({ 12: 1.5, 15: 2.5 }, zoom);
  }
  if (
    layer === "streets" ||
    layer === "street_polygons" ||
    layer === "transportation" ||
    layer === "road" ||
    layer === "highway"
  ) {
    return zoomStops(streetPaint(kind).width, zoom);
  }
  if (layer === "water_lines" || layer === "waterway") {
    const k = kind || "river";
    if (k === "river" || k === "canal") {
      return zoomStops({ 9: 1.5, 12: 2.5, 14: 4, 16: 7 }, zoom);
    }
    return zoomStops({ 12: 0.8, 14: 1.2, 16: 2 }, zoom);
  }
  if (layer === "boundaries" || layer === "boundary") {
    return zoomStops({ 4: 0.5, 8: 1, 12: 1.5 }, zoom);
  }
  return zoomStops({ 10: 1, 14: 1.5, 16: 2 }, zoom);
}

function styleCasing(name) {
  const { layer, kind } = splitLayerKind(name);
  if (layer === "fiber") {
    return null;
  }
  if (
    layer === "streets" ||
    layer === "street_polygons" ||
    layer === "transportation" ||
    layer === "road" ||
    layer === "highway"
  ) {
    return streetPaint(kind);
  }
  if (layer === "water_lines" || layer === "waterway") {
    return { casing: hex(0x8eb8d8), casingScale: 1.4, order: 49 };
  }
  return null;
}

/* ── .wmap parser ──────────────────────────────────────────────────── */

function u32(dv, o) {
  return dv.getUint32(o, true);
}
function u16(dv, o) {
  return dv.getUint16(o, true);
}

function parseWmap(buf) {
  const dv = new DataView(buf);
  if (buf.byteLength < 24) throw new Error("wmap too short");
  const magic = u32(dv, 0);
  if (magic !== 0x50414d57) throw new Error("bad magic");
  const version = u32(dv, 4);
  if (version !== 1) throw new Error("bad version " + version);
  const z = dv.getUint8(8);
  const x = u32(dv, 12);
  const y = u32(dv, 16);
  const nLayers = u32(dv, 20);
  let off = 24;
  const layers = [];
  for (let i = 0; i < nLayers; i++) {
    const kind = dv.getUint8(off++);
    const fclass = dv.getUint8(off++);
    const nlen = u16(dv, off);
    off += 2;
    const name = new TextDecoder().decode(new Uint8Array(buf, off, nlen));
    off += nlen;
    const extent = u32(dv, off);
    off += 4;
    const vc = u32(dv, off);
    off += 4;
    const ic = u32(dv, off);
    off += 4;
    const interleaved = new ArrayBuffer(vc * 12);
    const fview = new DataView(interleaved);
    for (let v = 0; v < vc; v++) {
      const px = dv.getFloat32(off, true);
      off += 4;
      const py = dv.getFloat32(off, true);
      off += 4;
      const c = u32(dv, off);
      off += 4;
      fview.setFloat32(v * 12, px, true);
      fview.setFloat32(v * 12 + 4, py, true);
      fview.setUint32(v * 12 + 8, c, true);
    }
    const indices = new Uint32Array(ic);
    for (let j = 0; j < ic; j++) {
      indices[j] = u32(dv, off);
      off += 4;
    }
    layers.push({ kind, fclass, name, extent, interleaved, indices, vc, ic });
  }
  return { z, x, y, layers };
}

/* ── Web Mercator helpers ──────────────────────────────────────────── */

const R = 6378137;

function lonLatToMerc(lon, lat) {
  const x = (R * lon * Math.PI) / 180;
  const y = R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
  return [x, y];
}

function mercToLonLat(mx, my) {
  const lon = (mx / R) * (180 / Math.PI);
  const lat =
    (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI);
  return [lon, lat];
}

function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lonW = (x / n) * 360 - 180;
  const lonE = ((x + 1) / n) * 360 - 180;
  const latN =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
  const latS =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
  return { lonW, latS, lonE, latN };
}

function tileSizeMerc(z) {
  return (2 * Math.PI * R) / 2 ** z;
}

/* ── Camera (smooth zoom) ──────────────────────────────────────────── */

const cam = {
  lon: -95.99,
  lat: 36.15,
  zoom: 10,
  targetZoom: 10,
  width: 1,
  height: 1,
  /** Stable world point under cursor for a zoom gesture. */
  zoomAnchor: null, // { mx, my, sx, sy }
  minZoom: 7,
  maxZoom: 18,
};

/** Cached CSS canvas size — never call getBoundingClientRect in the draw loop. */
const view = { w: 1, h: 1, dpr: 1 };
let zmin = 8;
let zmax = 12;
let lastFrameT = performance.now();
/** LOD hysteresis: only switch tile z after zoom crosses threshold. */
let activeTileZ = 10;
let lastStatusT = 0;
let zoomGestureActive = false;
let zoomGestureUntil = 0;

function projectCenter() {
  return lonLatToMerc(cam.lon, cam.lat);
}

/** Meters per CSS pixel at the given zoom (MapLibre/WebMercator tile size 256). */
function metersPerPixel(zoom = cam.zoom) {
  return (
    (Math.cos((cam.lat * Math.PI) / 180) * 2 * Math.PI * R) /
    (256 * 2 ** zoom)
  );
}

function syncViewSize() {
  const rect = canvas.getBoundingClientRect();
  view.w = Math.max(1, rect.width);
  view.h = Math.max(1, rect.height);
  view.dpr = devicePixelRatio || 1;
}

/** CSS-pixel → mercator at given zoom. */
function screenToMerc(cssX, cssY, zoom = cam.zoom) {
  const [cx, cy] = projectCenter();
  const mpp = metersPerPixel(zoom);
  const mx = cx + (cssX - view.w / 2) * mpp;
  const my = cy - (cssY - view.h / 2) * mpp;
  return [mx, my];
}

function setCenterMerc(mx, my) {
  const [lon, lat] = mercToLonLat(mx, my);
  cam.lon = lon;
  cam.lat = lat;
}

/**
 * Animate zoom toward target with exponential ease.
 * Keeps zoomAnchor under the cursor for the whole gesture (MapLibre-style).
 */
function updateZoomSmooth(dt, now) {
  if (zoomGestureActive && now > zoomGestureUntil) {
    zoomGestureActive = false;
  }

  const dz = cam.targetZoom - cam.zoom;
  if (Math.abs(dz) < 1e-4) {
    cam.zoom = cam.targetZoom;
    if (!zoomGestureActive) cam.zoomAnchor = null;
    return;
  }

  // Slightly snappier than before while still smooth (~MapLibre ~12–14).
  const k = 1 - Math.exp(-dt * 14);
  cam.zoom += dz * k;

  if (cam.zoomAnchor) {
    const { mx, my, sx, sy } = cam.zoomAnchor;
    const mpp = metersPerPixel(cam.zoom);
    const ncx = mx - (sx - view.w / 2) * mpp;
    const ncy = my + (sy - view.h / 2) * mpp;
    setCenterMerc(ncx, ncy);
  }
}

/** Mercator → slippy tile x/y at integer zoom. */
function mercToTileXY(mx, my, z) {
  const n = 2 ** z;
  const world = 2 * Math.PI * R;
  const x = ((mx + Math.PI * R) / world) * n;
  const y = ((Math.PI * R - my) / world) * n;
  return [x, y];
}

/**
 * Visible tile index range (inclusive) with padding for edge fill.
 * Returns null if invalid.
 */
function visibleTileRange(z, pad = 0.15) {
  const mpp = metersPerPixel();
  const [cx, cy] = projectCenter();
  const halfW = mpp * (view.w / 2) * (1 + pad);
  const halfH = mpp * (view.h / 2) * (1 + pad);
  const [x0, y0] = mercToTileXY(cx - halfW, cy + halfH, z); // NW
  const [x1, y1] = mercToTileXY(cx + halfW, cy - halfH, z); // SE
  const n = 2 ** z;
  const minX = Math.max(0, Math.floor(Math.min(x0, x1)));
  const maxX = Math.min(n - 1, Math.floor(Math.max(x0, x1)));
  const minY = Math.max(0, Math.floor(Math.min(y0, y1)));
  const maxY = Math.min(n - 1, Math.floor(Math.max(y0, y1)));
  return { minX, maxX, minY, maxY };
}

/* ── GPU setup ─────────────────────────────────────────────────────── */

const WGSL = /* wgsl */ `
struct Uniforms {
  scale: vec2f,
  translate: vec2f,
  // half-width in mercator meters for extruded lines; 0 for fills
  line_half_m: f32,
  _pad: f32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) color: vec4f,
};

fn unpack_rgba(c: u32) -> vec4f {
  let r = f32(c & 0xFFu) / 255.0;
  let g = f32((c >> 8u) & 0xFFu) / 255.0;
  let b = f32((c >> 16u) & 0xFFu) / 255.0;
  let a = f32((c >> 24u) & 0xFFu) / 255.0;
  return vec4f(r, g, b, max(a, 0.92));
}

@vertex
fn vs_main(
  @location(0) xy: vec2f,
  @location(1) normal: vec2f,
  @location(2) rgba: u32
) -> VSOut {
  var o: VSOut;
  let world = xy + normal * u.line_half_m;
  let p = (world + u.translate) * u.scale;
  o.pos = vec4f(p, 0.0, 1.0);
  o.color = unpack_rgba(rgba);
  return o;
}

@fragment
fn fs_main(i: VSOut) -> @location(0) vec4f {
  return i.color;
}
`;

let device, context, pipelineFill, uniformBuf, bindGroupLayout, bindGroup;
/** @type {Map<string, object[]>} key z/x/y → gpu layer draws */
const tileGpu = new Map();
/** Fiber feature display (data .fmap → lines GPU + Canvas taps) */
let fiberLayer = null;
let availableZooms = [];
let fiberZmin = 10;
let fiberZmax = 14;
let fiberTapZmin = 13;

async function initGpu() {
  if (!navigator.gpu) {
    throw new Error("WebGPU not available in this browser");
  }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) throw new Error("no GPU adapter");
  device = await adapter.requestDevice();
  context = canvas.getContext("webgpu");
  const format = navigator.gpu.getPreferredCanvasFormat();
  const resize = () => {
    syncViewSize();
    const dpr = view.dpr;
    canvas.width = Math.floor(view.w * dpr);
    canvas.height = Math.floor(view.h * dpr);
    cam.width = canvas.width;
    cam.height = canvas.height;
    context.configure({ device, format, alphaMode: "premultiplied" });
    if (labelCanvas) {
      labelCanvas.width = canvas.width;
      labelCanvas.height = canvas.height;
    }
  };
  resize();
  window.addEventListener("resize", resize);

  const module = device.createShaderModule({ code: WGSL });
  bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });
  const pipeLayout = device.createPipelineLayout({
    bindGroupLayouts: [bindGroupLayout],
  });
  // stride 20: xy(8) + normal(8) + rgba(4) → pad to 24 for alignment
  const vertexBuffers = [
    {
      arrayStride: 24,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" },
        { shaderLocation: 1, offset: 8, format: "float32x2" },
        { shaderLocation: 2, offset: 16, format: "uint32" },
      ],
    },
  ];

  pipelineFill = device.createRenderPipeline({
    layout: pipeLayout,
    vertex: { module, entryPoint: "vs_main", buffers: vertexBuffers },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [
        {
          format,
          blend: {
            color: {
              srcFactor: "src-alpha",
              dstFactor: "one-minus-src-alpha",
            },
            alpha: {
              srcFactor: "one",
              dstFactor: "one-minus-src-alpha",
            },
          },
        },
      ],
    },
    primitive: { topology: "triangle-list" },
  });

  uniformBuf = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });
}

function writeVertex(dv, i, x, y, nx, ny, rgba) {
  const o = i * 24;
  dv.setFloat32(o, x, true);
  dv.setFloat32(o + 4, y, true);
  dv.setFloat32(o + 8, nx, true);
  dv.setFloat32(o + 12, ny, true);
  dv.setUint32(o + 16, rgba, true);
  dv.setUint32(o + 20, 0, true); // pad
}

function tileLocalToMerc(tile, extent, vx, vy) {
  const size = tileSizeMerc(tile.z);
  const b = tileBounds(tile.z, tile.x, tile.y);
  const [ox] = lonLatToMerc(b.lonW, b.latS);
  const [, oyn] = lonLatToMerc(b.lonW, b.latN);
  const [, oys] = lonLatToMerc(b.lonW, b.latS);
  const h = oyn - oys;
  const mx = ox + (vx / extent) * size;
  const my = oyn - (vy / extent) * h;
  return [mx, my];
}

/**
 * Upload polygon layer as triangle list (normals zero).
 * When useVertexColor is true (fiber layers), keep per-vertex baked RGBA.
 */
function uploadFill(tile, layer, rgba, useVertexColor = false) {
  if (layer.vc === 0 || layer.ic === 0) return null;
  const extent = layer.extent || 4096;
  const src = new DataView(layer.interleaved);
  const out = new ArrayBuffer(layer.vc * 24);
  const dv = new DataView(out);
  for (let i = 0; i < layer.vc; i++) {
    const vx = src.getFloat32(i * 12, true);
    const vy = src.getFloat32(i * 12 + 4, true);
    const c = useVertexColor ? src.getUint32(i * 12 + 8, true) : rgba;
    const [mx, my] = tileLocalToMerc(tile, extent, vx, vy);
    writeVertex(dv, i, mx, my, 0, 0, c);
  }
  return createMesh(out, layer.indices, layer.ic, {
    name: layer.name,
    kind: "fill",
    order: styleOrder(layer.name),
    halfWidthPx: 0,
    z: tile.z,
    x: tile.x,
    y: tile.y,
  });
}

/**
 * Max miter length relative to half-width. Beyond this, clamp so sharp
 * corners do not spike outward (CSS lineJoin: miter / miterLimit).
 */
const LINE_MITER_LIMIT = 2.5;

/** Left unit normal of direction (dx, dy). Direction must be unit length. */
function leftNormal(dx, dy) {
  return [-dy, dx];
}

/**
 * Unit direction from A→B, or null if the segment is degenerate.
 */
function unitDir(x0, y0, x1, y1) {
  let dx = x1 - x0;
  let dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return null;
  return [dx / len, dy / len];
}

/**
 * Extrusion offset (shader multiplies by half-width) at polyline vertex i.
 * Endpoints use the adjacent segment normal; interior joins use a miter
 * (average of the two segment normals, scaled so half-width is preserved).
 * pts: interleaved mercator xy for source vertices; idx: polyline indices.
 */
function joinNormal(pts, idx, i, closed) {
  const n = idx.length;
  const pi = idx[i];
  const x = pts[pi * 2];
  const y = pts[pi * 2 + 1];

  // Previous / next points along the polyline
  let iPrev, iNext;
  if (closed) {
    iPrev = idx[(i - 1 + n) % n];
    iNext = idx[(i + 1) % n];
  } else if (i === 0) {
    const d = unitDir(x, y, pts[idx[1] * 2], pts[idx[1] * 2 + 1]);
    if (!d) return [0, 0];
    return leftNormal(d[0], d[1]);
  } else if (i === n - 1) {
    const d = unitDir(
      pts[idx[n - 2] * 2],
      pts[idx[n - 2] * 2 + 1],
      x,
      y
    );
    if (!d) return [0, 0];
    return leftNormal(d[0], d[1]);
  } else {
    iPrev = idx[i - 1];
    iNext = idx[i + 1];
  }

  const d0 = unitDir(pts[iPrev * 2], pts[iPrev * 2 + 1], x, y);
  const d1 = unitDir(x, y, pts[iNext * 2], pts[iNext * 2 + 1]);
  if (!d0 && !d1) return [0, 0];
  if (!d0) return leftNormal(d1[0], d1[1]);
  if (!d1) return leftNormal(d0[0], d0[1]);

  const n0 = leftNormal(d0[0], d0[1]);
  const n1 = leftNormal(d1[0], d1[1]);
  let mx = n0[0] + n1[0];
  let my = n0[1] + n1[1];
  const mlen = Math.hypot(mx, my);
  if (mlen < 1e-6) {
    // U-turn: fall back to segment normal
    return n0;
  }
  mx /= mlen;
  my /= mlen;
  // Scale so offset · n0 = 1 → constant half-width along both edges
  const cos = mx * n0[0] + my * n0[1];
  if (cos < 1e-4) return n0; // reflex / unstable: keep continuous with n0
  let scale = 1 / cos;
  if (scale > LINE_MITER_LIMIT) scale = LINE_MITER_LIMIT;
  return [mx * scale, my * scale];
}

/**
 * Walk a line-list index buffer and group into connected polylines
 * (segment end == next segment start). Closed rings appear as chains
 * whose first and last indices match.
 */
function collectPolylines(indices, indexCount, vertexCount) {
  const chains = [];
  let cur = null;
  for (let s = 0; s + 1 < indexCount; s += 2) {
    const i0 = indices[s];
    const i1 = indices[s + 1];
    if (i0 >= vertexCount || i1 >= vertexCount) continue;
    if (!cur) {
      cur = [i0, i1];
      continue;
    }
    if (cur[cur.length - 1] === i0) {
      cur.push(i1);
    } else {
      if (cur.length >= 2) chains.push(cur);
      cur = [i0, i1];
    }
  }
  if (cur && cur.length >= 2) chains.push(cur);
  return chains;
}

/**
 * Extrude polylines into triangle-list quads with miter joins.
 * Normals are unit (or miter-scaled); half-width applied in the shader.
 * pts: Float32Array interleaved mercator xy, length vc*2
 * cols: Uint32Array per source vertex (optional if !useVertexColor)
 * chains: array of index arrays into source vertices
 * Returns { buffer, indices, vertexCount, indexCount } or null.
 */
function extrudePolylines(pts, cols, chains, rgba, useVertexColor) {
  // Bound: 2 verts per polyline point, 6 indices per segment
  let maxPts = 0;
  let maxSegs = 0;
  for (let c = 0; c < chains.length; c++) {
    const ch = chains[c];
    const closed = ch.length >= 3 && ch[0] === ch[ch.length - 1];
    const nUnique = closed ? ch.length - 1 : ch.length;
    maxPts += nUnique;
    maxSegs += closed ? nUnique : nUnique - 1;
  }
  if (maxSegs <= 0) return null;

  const outVerts = new ArrayBuffer(maxPts * 2 * 24);
  const dv = new DataView(outVerts);
  const inds = new Uint32Array(maxSegs * 6);
  let vi = 0;
  let ii = 0;

  for (let c = 0; c < chains.length; c++) {
    const ch = chains[c];
    const closed = ch.length >= 3 && ch[0] === ch[ch.length - 1];
    // For closed rings drop the duplicate closing index for vertex loop
    const ring = closed ? ch.slice(0, -1) : ch;
    if (ring.length < 2) continue;

    // Skip zero-length rings
    let anySeg = false;
    for (let i = 0; i < ring.length; i++) {
      const j = closed ? (i + 1) % ring.length : i + 1;
      if (!closed && j >= ring.length) break;
      if (unitDir(
        pts[ring[i] * 2],
        pts[ring[i] * 2 + 1],
        pts[ring[j] * 2],
        pts[ring[j] * 2 + 1]
      )) {
        anySeg = true;
        break;
      }
    }
    if (!anySeg) continue;

    const base = vi;
    for (let i = 0; i < ring.length; i++) {
      const src = ring[i];
      const x = pts[src * 2];
      const y = pts[src * 2 + 1];
      const [nx, ny] = joinNormal(pts, ring, i, closed);
      const col = useVertexColor ? cols[src] : rgba;
      writeVertex(dv, vi++, x, y, nx, ny, col);
      writeVertex(dv, vi++, x, y, -nx, -ny, col);
    }

    const nV = ring.length;
    const nSeg = closed ? nV : nV - 1;
    for (let i = 0; i < nSeg; i++) {
      const a = base + i * 2;
      const b = base + ((i + 1) % nV) * 2;
      // a=left0, a+1=right0, b=left1, b+1=right1
      inds[ii++] = a;
      inds[ii++] = a + 1;
      inds[ii++] = b;
      inds[ii++] = a + 1;
      inds[ii++] = b + 1;
      inds[ii++] = b;
    }
  }

  if (vi === 0 || ii === 0) return null;
  return {
    buffer: outVerts.slice(0, vi * 24),
    indices: inds.slice(0, ii),
    vertexCount: vi,
    indexCount: ii,
  };
}

/**
 * Extrude line-list into triangle quads with miter joins at polyline corners.
 * Half-width applied in shader via uniform (screen-space → meters).
 * useVertexColor: per-endpoint color from .wmap (fiber cable/drop/tap border).
 */
function uploadLineExtruded(tile, layer, rgba, useVertexColor = false) {
  if (layer.vc === 0 || layer.ic < 2) return null;
  const extent = layer.extent || 4096;
  const src = new DataView(layer.interleaved);
  const pts = new Float32Array(layer.vc * 2);
  const cols = new Uint32Array(layer.vc);
  for (let i = 0; i < layer.vc; i++) {
    const vx = src.getFloat32(i * 12, true);
    const vy = src.getFloat32(i * 12 + 4, true);
    cols[i] = src.getUint32(i * 12 + 8, true);
    const [mx, my] = tileLocalToMerc(tile, extent, vx, vy);
    pts[i * 2] = mx;
    pts[i * 2 + 1] = my;
  }

  const chains = collectPolylines(layer.indices, layer.ic, layer.vc);
  const mesh = extrudePolylines(pts, cols, chains, rgba, useVertexColor);
  if (!mesh) return null;

  return createMesh(mesh.buffer, mesh.indices, mesh.indexCount, {
    name: layer.name,
    kind: "line",
    order: styleOrder(layer.name),
    // Width applied at draw time via styleLineWidth() + _widthScale.
    halfWidthPx: styleLineWidth(layer.name, 12),
    z: tile.z,
    x: tile.x,
    y: tile.y,
  });
}

function createMesh(vertBuf, indices, indexCount, meta) {
  const vb = device.createBuffer({
    size: Math.max(vertBuf.byteLength, 24),
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(vb.getMappedRange()).set(new Uint8Array(vertBuf));
  vb.unmap();

  const indBytes =
    indices instanceof Uint32Array
      ? indices.buffer.slice(
          indices.byteOffset,
          indices.byteOffset + indices.byteLength
        )
      : indices;
  const ib = device.createBuffer({
    size: Math.max(indexCount * 4, 4),
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(ib.getMappedRange()).set(new Uint8Array(indBytes));
  ib.unmap();

  return {
    vb,
    ib,
    indexCount,
    ...meta,
  };
}

/**
 * Choose basemap tile zoom with hysteresis so crossing an integer zoom
 * mid-gesture does not thrash between LOD levels (big hitch source).
 */
function updateActiveTileZoom(zoom) {
  const ideal = selectIdealTileZoom(zoom);
  if (!availableZooms.length) {
    activeTileZ = ideal;
    return activeTileZ;
  }
  if (!availableZooms.includes(activeTileZ)) {
    activeTileZ = ideal;
    return activeTileZ;
  }
  // Zooming in: keep coarser tiles until well into the next zoom band.
  if (ideal > activeTileZ && zoom >= activeTileZ + 0.8) {
    activeTileZ = ideal;
  }
  // Zooming out: overzoom finer tiles a bit before dropping LOD.
  if (ideal < activeTileZ && zoom <= ideal + 0.2) {
    activeTileZ = ideal;
  }
  return activeTileZ;
}

/** Scratch uniform buffer (reused — avoids alloc per write). */
const uniformScratch = new Float32Array(8);
const halfScratch = new Float32Array(2);

function writeCameraUniforms(halfWidthM) {
  const [cx, cy] = projectCenter();
  const mpp = metersPerPixel();
  const sx = 1 / (mpp * (view.w / 2));
  const sy = 1 / (mpp * (view.h / 2));
  uniformScratch[0] = sx;
  uniformScratch[1] = sy;
  uniformScratch[2] = -cx;
  uniformScratch[3] = -cy;
  uniformScratch[4] = halfWidthM;
  uniformScratch[5] = 0;
  device.queue.writeBuffer(uniformBuf, 0, uniformScratch);
}

/** Only update line_half_m after camera uniforms are already set. */
function writeHalfWidth(halfWidthM) {
  halfScratch[0] = halfWidthM;
  halfScratch[1] = 0;
  device.queue.writeBuffer(uniformBuf, 16, halfScratch);
}

/**
 * Collect GPU draws for the current viewport.
 * Frustum-culls basemap; fiber lines come from demo/display/fiber_layer.
 */
function collectDraws(tileZ) {
  const draws = [];
  const range = visibleTileRange(tileZ, 0.2);
  if (!range) return draws;

  for (let x = range.minX; x <= range.maxX; x++) {
    for (let y = range.minY; y <= range.maxY; y++) {
      const layers = tileGpu.get(`${tileZ}/${x}/${y}`);
      if (!layers) continue;
      for (let i = 0; i < layers.length; i++) draws.push(layers[i]);
    }
  }

  if (fiberLayer) {
    fiberLayer.collectLineDraws(draws, cam, view, metersPerPixel);
  }

  draws.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  return draws;
}

/**
 * Bucket draws by quantized half-width so we write uniforms once per bucket.
 * Quantize to 0.05m to keep buckets small while allowing zoom animation.
 */
function drawHalfWidth(g, mpp) {
  if (fiberLayer) {
    const fw = fiberLayer.halfWidthForDraw(g, cam, mpp);
    if (fw != null) return fw;
  }
  if (g.kind === "line") {
    const baseName = g.name.replace(/_casing$/, "");
    const px = styleLineWidth(baseName, cam.zoom) * (g._widthScale ?? 1);
    return px * 0.5 * mpp;
  }
  if (g.kind === "overlay-line") {
    return 2.0 * mpp;
  }
  return 0;
}

function frame(now) {
  if (!device) return;
  const dt = Math.min(0.05, (now - lastFrameT) / 1000);
  lastFrameT = now;
  updateZoomSmooth(dt, now);

  const tileZ = updateActiveTileZoom(cam.zoom);
  const draws = collectDraws(tileZ);
  const mpp = metersPerPixel();

  // Sort into width buckets for fewer GPU uniform updates
  // (fills first within same order already handled by sort; we re-group by halfM).
  // Walk in painter order; only change half-width when needed.
  const bg = STYLE.background;
  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: bg,
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });

  pass.setPipeline(pipelineFill);
  pass.setBindGroup(0, bindGroup);

  let lastHalf = NaN;
  let cameraWritten = false;
  for (let i = 0; i < draws.length; i++) {
    const g = draws[i];
    const halfM = drawHalfWidth(g, mpp);
    // Quantize comparison to avoid float thrash
    const q = Math.round(halfM * 40) / 40;
    if (!cameraWritten) {
      writeCameraUniforms(halfM);
      cameraWritten = true;
      lastHalf = q;
    } else if (q !== lastHalf) {
      writeHalfWidth(halfM);
      lastHalf = q;
    }
    pass.setVertexBuffer(0, g.vb);
    pass.setIndexBuffer(g.ib, "uint32");
    pass.drawIndexed(g.indexCount);
  }
  // Clear even if no draws
  if (!cameraWritten) {
    writeCameraUniforms(0);
  }

  pass.end();
  device.queue.submit([enc.finish()]);

  /* Canvas2D: fiber taps (circles + port digits) — display module owns style */
  if (labelCtx && labelCanvas) {
    labelCtx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
  }
  if (fiberLayer) {
    fiberLayer.paintSymbols(cam, view, metersPerPixel);
  }

  // Throttle DOM status (layout work was stealing frames during zoom)
  if (now - lastStatusT > 200) {
    lastStatusT = now;
    const fz = fiberLayer ? fiberLayer.selectFiberTileZoom(cam.zoom) : null;
    setStatus(
      `<span class="ok">WebGPU</span> · z ${cam.zoom.toFixed(2)} · base z${tileZ}` +
        (fz != null && fiberLayer?.show ? ` · fiber z${fz}` : "") +
        ` · ${draws.length} draws`
    );
  }

  requestAnimationFrame(frame);
}

/* ── Load tiles ────────────────────────────────────────────────────── */

/**
 * Normalize package manifest (docs/formats/data-packages.md).
 * Accepts legacy top-level source string or structured source.{adapter,label}.
 */
function normalizePackageManifest(raw) {
  const m = raw && typeof raw === "object" ? { ...raw } : {};
  const src = m.source;
  if (typeof src === "string") {
    m.source = { label: src };
  } else if (src && typeof src === "object") {
    m.source = {
      adapter: src.adapter,
      label: src.label ?? src.name ?? "",
      input_fingerprint: src.input_fingerprint,
    };
  } else {
    m.source = { label: "" };
  }
  if (m.kind == null) m.kind = "basemap";
  if (m.format_version == null) m.format_version = 0; /* pre-package */
  return m;
}

async function loadManifest() {
  const res = await fetch("./basemap/manifest.json");
  if (!res.ok) {
    throw new Error(
      "missing demo/basemap/manifest.json — run tools/basemap_pipeline/build_package.sh"
    );
  }
  return normalizePackageManifest(await res.json());
}

/**
 * Parse one .wmap into GPU meshes. isFiber attaches minZoom for LOD fade-in.
 */
function tileToGpuLayers(tile, isFiber) {
  const gpuLayers = [];
  for (const layer of tile.layers) {
    if (layer.name.includes("label") || layer.name.includes("place")) {
      continue;
    }
    /* Fiber design is loaded from .fmap via demo/display/, not basemap .wmap */
    if (isFiber || layer.name.startsWith("fiber/")) continue;
    const baked =
      layer.vc > 0
        ? new DataView(layer.interleaved).getUint32(8, true)
        : 0xffffffff;
    const rgba = styleColor(layer.name, baked);
    const perVertex = false;
    if (layer.kind === 0) {
      const g = uploadFill(tile, layer, rgba, perVertex);
      if (g) {
        gpuLayers.push(g);
      }
    } else if (layer.kind === 1) {
      const paint = styleCasing(layer.name);
      if (paint && paint.casing != null) {
        const casing = uploadLineExtruded(tile, layer, paint.casing, false);
        if (casing) {
          casing.name = layer.name + "_casing";
          casing.order = (paint.order ?? styleOrder(layer.name)) - 0.5;
          casing.kind = "line";
          casing._widthScale = paint.casingScale ?? 1.4;
          gpuLayers.push(casing);
        }
      }
      const g = uploadLineExtruded(tile, layer, rgba, perVertex);
      if (g) {
        g._widthScale = 1;
        gpuLayers.push(g);
      }
    }
    /* kind 2 POINT: basemap POIs unused; fiber taps use .fmap + display module */
  }
  if (gpuLayers.length) {
    gpuLayers.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));
  }
  return gpuLayers;
}

async function loadTilePyramid(manifest, baseUrl, targetMap, isFiber) {
  const byZoom = new Map();
  let loaded = 0;
  const queue = [...(manifest.tiles || [])];
  const workers = 8;
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      if (!t) break;
      const url = `${baseUrl}/${t.z}/${t.x}/${t.y}.wmap`;
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        const tile = parseWmap(buf);
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        const gpuLayers = tileToGpuLayers(tile, isFiber);
        if (gpuLayers.length) {
          targetMap.set(key, gpuLayers);
          if (!byZoom.has(tile.z)) byZoom.set(tile.z, 0);
          byZoom.set(tile.z, byZoom.get(tile.z) + 1);
          loaded++;
        }
      } catch (e) {
        log("tile fail " + url + ": " + e.message);
      }
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()));
  return { loaded, byZoom, total: manifest.tiles?.length ?? 0 };
}

async function loadTiles(manifest) {
  const { loaded, byZoom, total } = await loadTilePyramid(
    manifest,
    "./basemap",
    tileGpu,
    false
  );
  availableZooms = [...byZoom.keys()].sort((a, b) => a - b);
  zmin = availableZooms[0] ?? 8;
  zmax = availableZooms[availableZooms.length - 1] ?? 12;
  cam.minZoom = Math.max(6, Math.min(zmin, fiberZmin) - 1);
  cam.maxZoom = Math.max(18, Math.max(zmax, fiberZmax) + 6);
  activeTileZ = selectIdealTileZoom(cam.zoom);
  log(
    `basemap ${loaded}/${total} tiles (z ${availableZooms.join(",") || "—"})`
  );
}

async function loadFiberTiles() {
  try {
    const res = await fetch("./fiber_data/manifest.json");
    if (!res.ok) {
      log("no fiber_data/manifest.json — run fiber2features → demo/fiber_data");
      return null;
    }
    const man = await res.json();
    if (!fiberLayer) {
      log("fiber layer not initialized");
      return null;
    }
    const stats = await fiberLayer.loadPyramid(man, "./fiber_data");
    fiberZmin = stats.fiberZmin;
    fiberZmax = stats.fiberZmax;
    fiberTapZmin = stats.fiberTapZmin;
    cam.minZoom = Math.max(6, Math.min(zmin, fiberZmin) - 1);
    cam.maxZoom = Math.max(18, Math.max(zmax, fiberZmax) + 6);
    log(
      `fiber data ${stats.loaded}/${stats.total} tiles (z ${stats.availableZooms.join(",") || "—"}) · ` +
        `taps≥z${fiberTapZmin} · ` +
        `feats cables=${man.features?.cables ?? "?"} drops=${man.features?.drops ?? "?"} ` +
        `taps=${man.features?.taps ?? "?"} splices=${man.features?.splices ?? "?"}`
    );
    return man;
  } catch (e) {
    log("fiber data load failed: " + e.message);
    return null;
  }
}

function selectIdealTileZoom(zoom) {
  if (!availableZooms.length) return Math.floor(zoom);
  let ideal = availableZooms[0];
  for (const z of availableZooms) {
    if (z <= zoom + 0.05) ideal = z;
  }
  return ideal;
}

/* ── Interaction ───────────────────────────────────────────────────── */

let dragging = false;
let lastX = 0;
let lastY = 0;
/** Pointer-down position for click-vs-drag (CSS client coords). */
let ptrDownX = 0;
let ptrDownY = 0;
let ptrDidDrag = false;

canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  ptrDidDrag = false;
  lastX = e.clientX;
  lastY = e.clientY;
  ptrDownX = e.clientX;
  ptrDownY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  cam.zoomAnchor = null;
  cam.targetZoom = cam.zoom; // stop settle while panning
  if (fiberLayer) fiberLayer.cancelHover();
  canvas.style.cursor = "grabbing";
});
canvas.addEventListener("pointerup", (e) => {
  dragging = false;
  canvas.style.cursor = "";
  // Click (not drag): open splice diagram for tap / splicepoint under cursor
  if (
    !ptrDidDrag &&
    Math.hypot(e.clientX - ptrDownX, e.clientY - ptrDownY) < 6 &&
    fiberLayer?.show
  ) {
    const rect = canvas.getBoundingClientRect();
    const cssX = e.clientX - rect.left;
    const cssY = e.clientY - rect.top;
    fiberLayer.handleClick(cssX, cssY, view);
  }
});
canvas.addEventListener("pointerleave", () => {
  if (fiberLayer) fiberLayer.cancelHover();
  if (!dragging) canvas.style.cursor = "";
});
canvas.addEventListener("pointermove", (e) => {
  const rect = canvas.getBoundingClientRect();
  const cssX = e.clientX - rect.left;
  const cssY = e.clientY - rect.top;

  if (dragging) {
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX;
    lastY = e.clientY;
    if (Math.hypot(e.clientX - ptrDownX, e.clientY - ptrDownY) > 5)
      ptrDidDrag = true;
    const mpp = metersPerPixel(); // CSS pixels
    const [mx, my] = projectCenter();
    setCenterMerc(mx - dx * mpp, my + dy * mpp);
    if (fiberLayer) fiberLayer.cancelHover();
    return;
  }

  // Hover magnifier (dwell → enlarged feature + splice detail)
  if (fiberLayer?.show) {
    const over = fiberLayer.handleHover(
      cssX,
      cssY,
      view,
      cam,
      metersPerPixel,
      false
    );
    canvas.style.cursor = over ? "pointer" : "";
  }
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    if (fiberLayer) fiberLayer.cancelHover();
    // Use cached view size + offsetLeft/Top-free coords from the event target.
    const rect = canvas.getBoundingClientRect();
    // Keep view.w/h fresh if the window moved without a resize event.
    view.w = Math.max(1, rect.width);
    view.h = Math.max(1, rect.height);
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    // Stable zoom-around point for the whole gesture (do not re-sample
    // intermediate animated zoom — that causes hesitation/jitter).
    const pointerMoved =
      !cam.zoomAnchor ||
      Math.hypot(sx - cam.zoomAnchor.sx, sy - cam.zoomAnchor.sy) > 6;
    if (!zoomGestureActive || pointerMoved || !cam.zoomAnchor) {
      const [mx, my] = screenToMerc(sx, sy, cam.zoom);
      cam.zoomAnchor = { mx, my, sx, sy };
    } else {
      // Update screen anchor if pointer drifts slightly on trackpad.
      cam.zoomAnchor.sx = sx;
      cam.zoomAnchor.sy = sy;
    }
    zoomGestureActive = true;
    zoomGestureUntil = performance.now() + 180;

    // MapLibre-like continuous zoom: scale by wheel delta (no discrete jumps).
    // deltaMode: 0=pixel, 1=line, 2=page
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 16;
    else if (e.deltaMode === 2) dy *= view.h;
    // Normalize: ~100px wheel notch ≈ 0.35 zoom; trackpads send small pixels.
    const step = -dy * 0.0018;
    // Clamp single-event step so one tick never skips LOD violently
    const clamped = Math.max(-0.45, Math.min(0.45, step));
    cam.targetZoom = Math.max(
      cam.minZoom,
      Math.min(cam.maxZoom, cam.targetZoom + clamped)
    );
  },
  { passive: false }
);

/* Sidebar collapse — free map width; remeasure canvas after layout */
const wrapEl = document.getElementById("wrap");
const sidebarToggle = document.getElementById("sidebar-toggle");
if (sidebarToggle && wrapEl) {
  sidebarToggle.addEventListener("click", () => {
    const collapsed = wrapEl.classList.toggle("sidebar-collapsed");
    sidebarToggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
    sidebarToggle.title = collapsed ? "Expand sidebar" : "Collapse sidebar";
    sidebarToggle.textContent = collapsed ? "Info ›" : "‹ Info";
    // Remeasure after CSS grid transition (~200ms)
    setTimeout(() => window.dispatchEvent(new Event("resize")), 220);
  });
}

/* ── Optional WASM ─────────────────────────────────────────────────── */

async function tryWasm() {
  try {
    const res = await fetch("./webmap.wasm");
    if (!res.ok) {
      log("webmap.wasm not present (demo uses native .wmap parse)");
      return;
    }
    const bytes = await res.arrayBuffer();
    const mem = new WebAssembly.Memory({ initial: 256, maximum: 2048 });
    const { instance } = await WebAssembly.instantiate(bytes, {
      env: { memory: mem },
    });
    const id = instance.exports.webmap_wasm_build_id_ptr
      ? new TextDecoder().decode(
          new Uint8Array(
            mem.buffer,
            instance.exports.webmap_wasm_build_id_ptr(),
            32
          )
        )
      : "(exports ok)";
    log("WASM loaded: " + id.replace(/\0.*/g, ""));
  } catch (e) {
    log("WASM load skipped: " + e.message);
  }
}

/* ── Boot ──────────────────────────────────────────────────────────── */

(async () => {
  try {
    await initGpu();
    fiberLayer = createFiberLayer({
      device,
      labelCanvas,
      log,
    });
    setStatus('<span class="ok">WebGPU ready</span> — loading tiles…');
    const manifest = await loadManifest();
    if (manifest.source?.label) {
      log(
        `basemap package: ${manifest.name || manifest.kind || "basemap"}` +
          (manifest.source.adapter ? ` · ${manifest.source.adapter}` : "") +
          ` · ${manifest.source.label}`
      );
    }
    cam.lon = manifest.center?.[0] ?? cam.lon;
    cam.lat = manifest.center?.[1] ?? cam.lat;
    cam.zoom = manifest.zoom ?? 10;
    cam.targetZoom = cam.zoom;
    zmin = manifest.zmin ?? 8;
    zmax = manifest.zmax ?? 12;
    await loadTiles(manifest);
    const fiberMan = await loadFiberTiles();

    /* Center on fiber network when design tiles are present */
    if (fiberMan?.center) {
      cam.lon = fiberMan.center[0];
      cam.lat = fiberMan.center[1];
      cam.zoom = Math.max(fiberMan.zoom ?? 12, fiberTapZmin - 1);
      cam.targetZoom = cam.zoom;
      log(
        `centered on fiber network ${cam.lon.toFixed(4)}, ${cam.lat.toFixed(4)} z${cam.zoom}`
      );
    }

    await tryWasm();
    log(
      "demo ready — basemap .wmap · fiber .fmap · taps=circles · splices=hexagons · " +
        "hover 0.5s magnifier · click opens splice diagram · symbols ≥z" +
        fiberTapZmin
    );
    lastFrameT = performance.now();
    requestAnimationFrame(frame);
  } catch (e) {
    setStatus('<span class="err">' + e.message + "</span>");
    log(String(e.stack || e));
  }
})();
