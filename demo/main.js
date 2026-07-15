/**
 * libwebmap WebGPU host demo.
 * Parses .wmap basemap tiles and draws with WebGPU (Shortbread-inspired style).
 * Features: extruded roads/water, LOD, smooth wheel zoom, overzoom past tile max.
 */

const logEl = document.getElementById("log");
const statusEl = document.getElementById("status");
const canvas = document.getElementById("c");

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
  /** Anchor mercator point kept under cursor during animated zoom. */
  zoomAnchor: null, // { mx, my, sx, sy } sx/sy in CSS px relative to canvas
  minZoom: 7,
  maxZoom: 18,
};

let zmin = 8;
let zmax = 12;
let lastFrameT = performance.now();

function projectCenter() {
  return lonLatToMerc(cam.lon, cam.lat);
}

/** Meters per CSS pixel at the given zoom (MapLibre/WebMercator tile size 512/256). */
function metersPerPixel(zoom = cam.zoom) {
  return (
    (Math.cos((cam.lat * Math.PI) / 180) * 2 * Math.PI * R) /
    (256 * 2 ** zoom)
  );
}

function canvasCssSize() {
  const rect = canvas.getBoundingClientRect();
  return { w: rect.width, h: rect.height };
}

/** CSS-pixel → mercator at current cam. */
function screenToMerc(cssX, cssY, zoom = cam.zoom) {
  const { w, h } = canvasCssSize();
  const [cx, cy] = projectCenter();
  const mpp = metersPerPixel(zoom) ;
  // canvas internal size uses DPR; client coords are CSS pixels
  const mx = cx + (cssX - w / 2) * mpp;
  const my = cy - (cssY - h / 2) * mpp;
  return [mx, my];
}

function setCenterMerc(mx, my) {
  const [lon, lat] = mercToLonLat(mx, my);
  cam.lon = lon;
  cam.lat = lat;
}

function updateZoomSmooth(dt) {
  const dz = cam.targetZoom - cam.zoom;
  if (Math.abs(dz) < 1e-4) {
    cam.zoom = cam.targetZoom;
    cam.zoomAnchor = null;
    return;
  }
  // Exponential ease (~MapLibre feel)
  const k = 1 - Math.exp(-dt * 10);
  const prev = cam.zoom;
  cam.zoom = prev + dz * k;

  if (cam.zoomAnchor) {
    const { mx, my, sx, sy } = cam.zoomAnchor;
    // Keep anchor under the same screen point after zoom change.
    const [cx0, cy0] = projectCenter();
    // Where anchor would appear after zoom without center adjust:
    // screen offset from center in CSS: (mx - cx) / mpp
    const mpp = metersPerPixel(cam.zoom);
    const { w, h } = canvasCssSize();
    // desired: mx = cx + (sx - w/2) * mpp  =>  cx = mx - (sx - w/2) * mpp
    const ncx = mx - (sx - w / 2) * mpp;
    const ncy = my + (sy - h / 2) * mpp;
    setCenterMerc(ncx, ncy);
    void cx0;
    void cy0;
    void prev;
  }
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
let overlays = [];
let availableZooms = [];

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
    const dpr = devicePixelRatio || 1;
    canvas.width = Math.floor(canvas.clientWidth * dpr);
    canvas.height = Math.floor(canvas.clientHeight * dpr);
    cam.width = canvas.width;
    cam.height = canvas.height;
    context.configure({ device, format, alphaMode: "premultiplied" });
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

/** Upload polygon layer as triangle list (normals zero). */
function uploadFill(tile, layer, rgba) {
  if (layer.vc === 0 || layer.ic === 0) return null;
  const extent = layer.extent || 4096;
  const src = new DataView(layer.interleaved);
  const out = new ArrayBuffer(layer.vc * 24);
  const dv = new DataView(out);
  for (let i = 0; i < layer.vc; i++) {
    const vx = src.getFloat32(i * 12, true);
    const vy = src.getFloat32(i * 12 + 4, true);
    const [mx, my] = tileLocalToMerc(tile, extent, vx, vy);
    writeVertex(dv, i, mx, my, 0, 0, rgba);
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
 * Extrude line-list into triangle strip quads with unit normals.
 * Half-width applied in shader via uniform (screen-space → meters).
 */
function uploadLineExtruded(tile, layer, rgba) {
  if (layer.vc === 0 || layer.ic < 2) return null;
  const extent = layer.extent || 4096;
  const src = new DataView(layer.interleaved);
  const pts = new Float32Array(layer.vc * 2);
  for (let i = 0; i < layer.vc; i++) {
    const vx = src.getFloat32(i * 12, true);
    const vy = src.getFloat32(i * 12 + 4, true);
    const [mx, my] = tileLocalToMerc(tile, extent, vx, vy);
    pts[i * 2] = mx;
    pts[i * 2 + 1] = my;
  }

  // Worst case: each segment → 4 verts, 6 indices
  const segCount = layer.ic / 2;
  const outVerts = new ArrayBuffer(Math.ceil(segCount) * 4 * 24);
  const dv = new DataView(outVerts);
  const inds = new Uint32Array(Math.ceil(segCount) * 6);
  let vi = 0;
  let ii = 0;

  for (let s = 0; s < layer.ic; s += 2) {
    const i0 = layer.indices[s];
    const i1 = layer.indices[s + 1];
    if (i0 >= layer.vc || i1 >= layer.vc) continue;
    const x0 = pts[i0 * 2];
    const y0 = pts[i0 * 2 + 1];
    const x1 = pts[i1 * 2];
    const y1 = pts[i1 * 2 + 1];
    let dx = x1 - x0;
    let dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    dx /= len;
    dy /= len;
    // Unit normal (left of direction)
    const nx = -dy;
    const ny = dx;

    const base = vi;
    writeVertex(dv, vi++, x0, y0, nx, ny, rgba);
    writeVertex(dv, vi++, x0, y0, -nx, -ny, rgba);
    writeVertex(dv, vi++, x1, y1, nx, ny, rgba);
    writeVertex(dv, vi++, x1, y1, -nx, -ny, rgba);
    // two triangles
    inds[ii++] = base;
    inds[ii++] = base + 1;
    inds[ii++] = base + 2;
    inds[ii++] = base + 1;
    inds[ii++] = base + 3;
    inds[ii++] = base + 2;
  }

  if (vi === 0) return null;
  const tight = outVerts.slice(0, vi * 24);
  const tightInd = inds.slice(0, ii);
  return createMesh(tight, tightInd, ii, {
    name: layer.name,
    kind: "line",
    order: styleOrder(layer.name),
    halfWidthPx: STYLE.lineWidthPx[layer.name] ?? STYLE.lineWidthPx.default,
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

function selectTileZoom(zoom) {
  if (!availableZooms.length) return Math.floor(zoom);
  // Prefer highest tile zoom <= floor(zoom); else lowest available (underzoom).
  const zWant = Math.floor(zoom);
  let best = availableZooms[0];
  for (const z of availableZooms) {
    if (z <= zWant) best = z;
  }
  // If zooming past max tile, use max (overzoom).
  if (zWant >= availableZooms[availableZooms.length - 1]) {
    return availableZooms[availableZooms.length - 1];
  }
  return best;
}

function writeUniforms(halfWidthM) {
  const [cx, cy] = projectCenter();
  const mpp = metersPerPixel();
  // Project in CSS pixels so 1 CSS px = mpp meters (independent of devicePixelRatio).
  const { w, h } = canvasCssSize();
  const sx = 1 / (mpp * (w / 2));
  const sy = 1 / (mpp * (h / 2));
  // layout: scale.xy, translate.xy, line_half_m, pad
  const u = new Float32Array(8);
  u[0] = sx;
  u[1] = sy;
  u[2] = -cx;
  u[3] = -cy;
  u[4] = halfWidthM;
  u[5] = 0;
  device.queue.writeBuffer(uniformBuf, 0, u);
}

function frame(now) {
  if (!device) return;
  const dt = Math.min(0.05, (now - lastFrameT) / 1000);
  lastFrameT = now;
  updateZoomSmooth(dt);

  const tileZ = selectTileZoom(cam.zoom);
  const draws = [];
  for (const [key, layers] of tileGpu) {
    const z = parseInt(key.split("/")[0], 10);
    if (z !== tileZ) continue;
    for (const g of layers) draws.push(g);
  }
  for (const g of overlays) draws.push(g);
  draws.sort((a, b) => (a.order ?? 50) - (b.order ?? 50));

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

  // Group by half-width to minimize uniform writes
  let lastHalf = NaN;
  for (const g of draws) {
    let halfM = 0;
    if (g.kind === "line") {
      const baseName = g.name.replace(/_casing$/, "");
      const px =
        styleLineWidth(baseName, cam.zoom) * (g._widthScale ?? 1);
      // full width in CSS px → half-width in merc meters
      halfM = px * 0.5 * metersPerPixel();
    } else if (g.kind === "overlay-line") {
      halfM = 2.0 * metersPerPixel();
    }
    if (halfM !== lastHalf) {
      writeUniforms(halfM);
      lastHalf = halfM;
    }
    pass.setVertexBuffer(0, g.vb);
    pass.setIndexBuffer(g.ib, "uint32");
    pass.drawIndexed(g.indexCount);
  }

  pass.end();
  device.queue.submit([enc.finish()]);

  // Status line
  setStatus(
    `<span class="ok">WebGPU</span> · z ${cam.zoom.toFixed(2)} · tiles z${tileZ} · ` +
      `${draws.length} layers`
  );

  requestAnimationFrame(frame);
}

/* ── Load tiles ────────────────────────────────────────────────────── */

async function loadManifest() {
  const res = await fetch("./tiles/manifest.json");
  if (!res.ok) {
    throw new Error(
      "missing demo/tiles/manifest.json — run tools/prepare_demo_tiles.sh"
    );
  }
  return res.json();
}

async function loadTiles(manifest) {
  const byZoom = new Map();
  let loaded = 0;
  // Parallel fetch with modest concurrency
  const queue = [...manifest.tiles];
  const workers = 8;
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      if (!t) break;
      const url = `./tiles/${t.z}/${t.x}/${t.y}.wmap`;
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const buf = await r.arrayBuffer();
        const tile = parseWmap(buf);
        const key = `${tile.z}/${tile.x}/${tile.y}`;
        const gpuLayers = [];
        for (const layer of tile.layers) {
          if (
            layer.name.includes("label") ||
            layer.name.includes("place")
          ) {
            continue;
          }
          const rgba = styleColor(
            layer.name,
            new DataView(layer.interleaved).getUint32(8, true)
          );
          if (layer.kind === 0) {
            const g = uploadFill(tile, layer, rgba);
            if (g) gpuLayers.push(g);
          } else if (layer.kind === 1) {
            const paint = styleCasing(layer.name);
            if (paint && paint.casing != null) {
              // Outline / casing under the road/water fill (MapLibre dual-pass).
              const casing = uploadLineExtruded(tile, layer, paint.casing);
              if (casing) {
                casing.name = layer.name + "_casing";
                casing.order = (paint.order ?? styleOrder(layer.name)) - 0.5;
                casing.kind = "line";
                casing._widthScale = paint.casingScale ?? 1.4;
                gpuLayers.push(casing);
              }
            }
            const g = uploadLineExtruded(tile, layer, rgba);
            if (g) {
              g._widthScale = 1;
              gpuLayers.push(g);
            }
          }
          // skip points
        }
        if (gpuLayers.length) {
          tileGpu.set(key, gpuLayers);
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
  availableZooms = [...byZoom.keys()].sort((a, b) => a - b);
  zmin = availableZooms[0] ?? 8;
  zmax = availableZooms[availableZooms.length - 1] ?? 12;
  cam.minZoom = Math.max(6, zmin - 1);
  // Allow overzoom well past max tile for "closer look"
  cam.maxZoom = Math.max(18, zmax + 6);
  log(
    `loaded ${loaded}/${manifest.tiles.length} tiles (z ${availableZooms.join(",")})`
  );
}

/* ── Overlays ──────────────────────────────────────────────────────── */

function makeOverlayLine(pointsLonLat, rgba) {
  const n = pointsLonLat.length;
  if (n < 2) return null;
  const merc = pointsLonLat.map(([lon, lat]) => lonLatToMerc(lon, lat));
  const segs = n - 1;
  const out = new ArrayBuffer(segs * 4 * 24);
  const dv = new DataView(out);
  const inds = new Uint32Array(segs * 6);
  let vi = 0;
  let ii = 0;
  for (let i = 0; i < segs; i++) {
    const [x0, y0] = merc[i];
    const [x1, y1] = merc[i + 1];
    let dx = x1 - x0;
    let dy = y1 - y0;
    const len = Math.hypot(dx, dy) || 1;
    dx /= len;
    dy /= len;
    const nx = -dy;
    const ny = dx;
    const base = vi;
    writeVertex(dv, vi++, x0, y0, nx, ny, rgba);
    writeVertex(dv, vi++, x0, y0, -nx, -ny, rgba);
    writeVertex(dv, vi++, x1, y1, nx, ny, rgba);
    writeVertex(dv, vi++, x1, y1, -nx, -ny, rgba);
    inds[ii++] = base;
    inds[ii++] = base + 1;
    inds[ii++] = base + 2;
    inds[ii++] = base + 1;
    inds[ii++] = base + 3;
    inds[ii++] = base + 2;
  }
  return createMesh(out, inds, ii, {
    name: "overlay",
    kind: "overlay-line",
    order: styleOrder("overlay"),
    halfWidthPx: 3,
  });
}

let showFiber = true;
let showPower = true;
let fiberGpu = null;
let powerGpu = null;
let outageGpu = null;

function rebuildOverlays() {
  overlays = [];
  if (showFiber && fiberGpu) overlays.push(fiberGpu);
  if (showPower && powerGpu) overlays.push(powerGpu);
  if (outageGpu) overlays.push(outageGpu);
}

/* ── Interaction ───────────────────────────────────────────────────── */

let dragging = false;
let lastX = 0;
let lastY = 0;

canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
  cam.zoomAnchor = null;
  cam.targetZoom = cam.zoom; // stop settle while panning
});
canvas.addEventListener("pointerup", () => {
  dragging = false;
});
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  const mpp = metersPerPixel(); // CSS pixels
  const [mx, my] = projectCenter();
  setCenterMerc(mx - dx * mpp, my + dy * mpp);
});

canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    // Capture world point under cursor at current display zoom
    const [mx, my] = screenToMerc(sx, sy, cam.zoom);
    cam.zoomAnchor = { mx, my, sx, sy };

    // Smooth, continuous zoom (trackpad-friendly)
    const speed = 0.0025;
    const delta = -e.deltaY * speed * (e.deltaMode === 1 ? 20 : 1);
    // Larger notches for mouse wheels
    const step =
      Math.abs(e.deltaY) > 50
        ? e.deltaY > 0
          ? -0.35
          : 0.35
        : delta;
    cam.targetZoom = Math.max(
      cam.minZoom,
      Math.min(cam.maxZoom, cam.targetZoom + step)
    );
  },
  { passive: false }
);

document.getElementById("btn-fiber").onclick = () => {
  showFiber = !showFiber;
  rebuildOverlays();
  log("fiber " + (showFiber ? "on" : "off"));
};
document.getElementById("btn-power").onclick = () => {
  showPower = !showPower;
  rebuildOverlays();
  log("power " + (showPower ? "on" : "off"));
};
document.getElementById("btn-outage").onclick = () => {
  if (outageGpu) {
    outageGpu = null;
  } else {
    outageGpu = makeOverlayLine(
      [
        [-96.05, 36.12],
        [-95.95, 36.12],
        [-95.9, 36.18],
      ],
      0xffe74c3c
    );
  }
  rebuildOverlays();
  log("outage " + (outageGpu ? "simulated" : "cleared"));
};

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
    setStatus('<span class="ok">WebGPU ready</span> — loading tiles…');
    const manifest = await loadManifest();
    cam.lon = manifest.center?.[0] ?? cam.lon;
    cam.lat = manifest.center?.[1] ?? cam.lat;
    cam.zoom = manifest.zoom ?? 10;
    cam.targetZoom = cam.zoom;
    zmin = manifest.zmin ?? 8;
    zmax = manifest.zmax ?? 12;
    await loadTiles(manifest);

    fiberGpu = makeOverlayLine(
      [
        [-96.1, 36.0],
        [-95.99, 36.15],
        [-95.85, 36.2],
        [-95.7, 36.05],
      ],
      0xff9b59b6
    );
    powerGpu = makeOverlayLine(
      [
        [-96.2, 36.1],
        [-96.0, 36.1],
        [-95.9, 35.95],
        [-95.8, 35.85],
      ],
      0xffe67e22
    );
    rebuildOverlays();
    await tryWasm();
    log("demo ready — pan, smooth wheel-zoom (overzoom past tile max)");
    lastFrameT = performance.now();
    requestAnimationFrame(frame);
  } catch (e) {
    setStatus('<span class="err">' + e.message + "</span>");
    log(String(e.stack || e));
  }
})();
