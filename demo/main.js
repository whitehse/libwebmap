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

/* ── Shortbread / MapLibre-inspired paint ──────────────────────────── */

/** Packed 0xAABBGGRR (little-endian RGBA). */
const STYLE = {
  background: { r: 0.949, g: 0.941, b: 0.902, a: 1 }, // #f2efe6
  // Override baked colors so style can evolve without re-tiling.
  colors: {
    land: 0xffe9eff2, // #f2efe9
    water_polygons: 0xffdfd3aa, // #aad3df
    water: 0xffdfd3aa,
    water_lines: 0xffe8c49a, // #9ac4e8 slightly deeper rivers
    waterway: 0xffe8c49a,
    streets: 0xffffffff, // #ffffff
    road: 0xffffffff,
    transportation: 0xffffffff,
    highway: 0xffffffff,
    street_polygons: 0xfff5f5f5,
    building: 0xffc6d3de, // #ded3c6
    buildings: 0xffc6d3de,
    landuse: 0xffc8f2c4, // #c4f2c8
    landcover: 0xffc8f2c4,
    park: 0xffc8f2c4,
    boundary: 0xffb8afa4,
    boundaries: 0xffb8afa4,
    public_transport: 0xff5a9fd4,
    pois: 0xff5a9fd4,
    sites: 0xff5a9fd4,
  },
  /** Screen-space half-width in CSS pixels at reference zoom (scales gently). */
  lineWidthPx: {
    streets: 2.4,
    road: 2.4,
    transportation: 2.4,
    highway: 3.2,
    street_polygons: 4.0,
    water_lines: 1.6,
    waterway: 1.6,
    default: 1.2,
  },
  /** Draw priority (lower first). */
  order: {
    land: 10,
    landuse: 20,
    landcover: 20,
    park: 20,
    building: 30,
    buildings: 30,
    water_polygons: 40,
    water: 40,
    water_lines: 50,
    waterway: 50,
    streets: 60,
    road: 60,
    transportation: 60,
    highway: 60,
    street_polygons: 65,
    boundary: 70,
    boundaries: 70,
    public_transport: 80,
    overlay: 100,
  },
};

function styleColor(name, baked) {
  return STYLE.colors[name] ?? baked;
}

function styleOrder(name) {
  return STYLE.order[name] ?? 55;
}

function styleLineWidth(name, zoom) {
  const base = STYLE.lineWidthPx[name] ?? STYLE.lineWidthPx.default;
  // Slightly thicker when zoomed in (MapLibre-like).
  const t = Math.max(0, Math.min(1, (zoom - 9) / 6));
  return base * (0.85 + t * 0.9);
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
            const isStreet =
              layer.name === "streets" ||
              layer.name === "road" ||
              layer.name === "transportation" ||
              layer.name === "highway";
            if (isStreet) {
              // Casing (darker, wider) under white road fill — MapLibre-like.
              const casing = uploadLineExtruded(tile, layer, 0xffc4bfb6);
              if (casing) {
                casing.name = layer.name + "_casing";
                casing.order = styleOrder(layer.name) - 1;
                casing.halfWidthPx =
                  (STYLE.lineWidthPx[layer.name] ?? STYLE.lineWidthPx.default) *
                  1.55;
                // Mark so styleLineWidth uses casing multiplier
                casing.kind = "line";
                casing._widthScale = 1.55;
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
