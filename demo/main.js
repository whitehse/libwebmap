/**
 * libwebmap WebGPU host demo.
 * Parses .wmap basemap tiles (native buffer path) and draws with WebGPU.
 * Optional: load webmap.wasm if present (freestanding clang build).
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

/* ── .wmap parser (mirrors webmap_wmap_encode) ─────────────────────── */

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
    const verts = new Float32Array(vc * 3); // x,y,rgbaAsFloat
    const rgba = new Uint32Array(vc);
    for (let v = 0; v < vc; v++) {
      const x = dv.getFloat32(off, true);
      off += 4;
      const y = dv.getFloat32(off, true);
      off += 4;
      const c = u32(dv, off);
      off += 4;
      verts[v * 3] = x;
      verts[v * 3 + 1] = y;
      verts[v * 3 + 2] = 0; // placeholder; color in rgba
      rgba[v] = c;
    }
    // repack as interleaved x,y,rgba_f32 for simple shader: use u32 bits as f32
    const interleaved = new ArrayBuffer(vc * 12);
    const fview = new DataView(interleaved);
    for (let v = 0; v < vc; v++) {
      fview.setFloat32(v * 12, verts[v * 3], true);
      fview.setFloat32(v * 12 + 4, verts[v * 3 + 1], true);
      fview.setUint32(v * 12 + 8, rgba[v], true);
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

function tileOriginMerc(z, x, y) {
  const b = tileBounds(z, x, y);
  return lonLatToMerc(b.lonW, b.latN); // NW corner in mercator (y decreases south in tiles)
}

/* MVT tile coords: (0,0) NW, y down. Mercator y increases north.
 * position in merc: 
 *   mx = lonW_merc + (vx/extent) * tileWidth
 *   my = latN_merc - (vy/extent) * tileHeight
 */
function tileSizeMerc(z) {
  const n = 2 ** z;
  return (2 * Math.PI * R) / n;
}

/* ── Camera ────────────────────────────────────────────────────────── */

const cam = {
  lon: -95.99,
  lat: 36.15,
  zoom: 10,
  width: 1,
  height: 1,
};

function projectCenter() {
  return lonLatToMerc(cam.lon, cam.lat);
}

function metersPerPixel() {
  const [_, my] = projectCenter();
  const lat =
    (2 * Math.atan(Math.exp(my / R)) - Math.PI / 2) * (180 / Math.PI);
  const cosLat = Math.cos((lat * Math.PI) / 180);
  return (Math.cos((cam.lat * Math.PI) / 180) * 2 * Math.PI * R) /
    (256 * 2 ** cam.zoom);
}

/* ── GPU setup ─────────────────────────────────────────────────────── */

const WGSL = /* wgsl */ `
struct Uniforms {
  scale: vec2f,
  translate: vec2f,
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
  return vec4f(r, g, b, max(a, 0.85));
}

@vertex
fn vs_main(@location(0) xy: vec2f, @location(1) rgba: u32) -> VSOut {
  var o: VSOut;
  let p = (xy + u.translate) * u.scale;
  o.pos = vec4f(p, 0.0, 1.0);
  o.color = unpack_rgba(rgba);
  return o;
}

@fragment
fn fs_main(i: VSOut) -> @location(0) vec4f {
  return i.color;
}
`;

let device, context, pipelineLine, pipelineFill, uniformBuf, bindGroup;
const gpuTiles = []; // { buffers, kind, z,x,y }
let overlays = [];

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
  const layout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX,
        buffer: { type: "uniform" },
      },
    ],
  });
  const pipeLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const vertexBuffers = [
    {
      arrayStride: 12,
      attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x2" },
        { shaderLocation: 1, offset: 8, format: "uint32" },
      ],
    },
  ];

  pipelineLine = device.createRenderPipeline({
    layout: pipeLayout,
    vertex: { module, entryPoint: "vs_main", buffers: vertexBuffers },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format, blend: {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      }}],
    },
    primitive: { topology: "line-list" },
  });
  pipelineFill = device.createRenderPipeline({
    layout: pipeLayout,
    vertex: { module, entryPoint: "vs_main", buffers: vertexBuffers },
    fragment: {
      module,
      entryPoint: "fs_main",
      targets: [{ format, blend: {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha" },
        alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
      }}],
    },
    primitive: { topology: "triangle-list" },
  });

  uniformBuf = device.createBuffer({
    size: 16,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  bindGroup = device.createBindGroup({
    layout,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });
}

function uploadLayer(tile, layer) {
  if (layer.vc === 0 || layer.ic === 0) return null;
  // Convert tile-local to mercator meters relative to world origin 0
  const extent = layer.extent || 4096;
  const size = tileSizeMerc(tile.z);
  const b = tileBounds(tile.z, tile.x, tile.y);
  const [ox] = lonLatToMerc(b.lonW, b.latS);
  const [, oyn] = lonLatToMerc(b.lonW, b.latN);
  const [, oys] = lonLatToMerc(b.lonW, b.latS);
  const h = oyn - oys;

  const src = new DataView(layer.interleaved);
  const out = new ArrayBuffer(layer.vc * 12);
  const dv = new DataView(out);
  for (let i = 0; i < layer.vc; i++) {
    const vx = src.getFloat32(i * 12, true);
    const vy = src.getFloat32(i * 12 + 4, true);
    const rgba = src.getUint32(i * 12 + 8, true);
    const mx = ox + (vx / extent) * size;
    const my = oyn - (vy / extent) * h;
    dv.setFloat32(i * 12, mx, true);
    dv.setFloat32(i * 12 + 4, my, true);
    dv.setUint32(i * 12 + 8, rgba, true);
  }
  const vb = device.createBuffer({
    size: out.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(vb.getMappedRange()).set(new Uint8Array(out));
  vb.unmap();

  const ib = device.createBuffer({
    size: layer.indices.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(ib.getMappedRange()).set(new Uint8Array(layer.indices.buffer));
  ib.unmap();

  return {
    vb,
    ib,
    indexCount: layer.ic,
    kind: layer.kind, // 0 fill, 1 line, 2 point
    name: layer.name,
  };
}

function frame() {
  if (!device) return;
  const [cx, cy] = projectCenter();
  const mpp = metersPerPixel();
  // NDC: x_ndc = (mx - cx) / (mpp * width/2)
  const sx = 1 / (mpp * (cam.width / 2));
  const sy = 1 / (mpp * (cam.height / 2));
  const u = new Float32Array([sx, sy, -cx, -cy]);
  device.queue.writeBuffer(uniformBuf, 0, u);

  const enc = device.createCommandEncoder();
  const pass = enc.beginRenderPass({
    colorAttachments: [
      {
        view: context.getCurrentTexture().createView(),
        clearValue: { r: 0.05, g: 0.08, b: 0.12, a: 1 },
        loadOp: "clear",
        storeOp: "store",
      },
    ],
  });

  const drawList = [...gpuTiles, ...overlays];
  // fills first
  for (const g of drawList) {
    if (g.kind !== 0) continue;
    pass.setPipeline(pipelineFill);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, g.vb);
    pass.setIndexBuffer(g.ib, "uint32");
    pass.drawIndexed(g.indexCount);
  }
  for (const g of drawList) {
    if (g.kind === 0) continue;
    pass.setPipeline(g.kind === 0 ? pipelineFill : pipelineLine);
    pass.setBindGroup(0, bindGroup);
    pass.setVertexBuffer(0, g.vb);
    pass.setIndexBuffer(g.ib, "uint32");
    pass.drawIndexed(g.indexCount);
  }
  pass.end();
  device.queue.submit([enc.finish()]);
  requestAnimationFrame(frame);
}

/* ── Load tiles from manifest ──────────────────────────────────────── */

async function loadManifest() {
  const res = await fetch("./tiles/manifest.json");
  if (!res.ok) throw new Error("missing demo/tiles/manifest.json — run tools/prepare_demo_tiles.sh");
  return res.json();
}

async function loadTiles(manifest) {
  let loaded = 0;
  for (const t of manifest.tiles) {
    const url = `./tiles/${t.z}/${t.x}/${t.y}.wmap`;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      const tile = parseWmap(buf);
      for (const layer of tile.layers) {
        // skip label layers for clarity
        if (layer.name.includes("label") || layer.name.includes("place")) continue;
        const g = uploadLayer(tile, layer);
        if (g) gpuTiles.push(g);
      }
      loaded++;
    } catch (e) {
      log("tile fail " + url + ": " + e.message);
    }
  }
  log(`loaded ${loaded}/${manifest.tiles.length} tiles`);
}

/* ── Overlays (fiber / power) ──────────────────────────────────────── */

function makeOverlayLine(pointsLonLat, rgba, kind = 1) {
  const verts = new ArrayBuffer(pointsLonLat.length * 12);
  const dv = new DataView(verts);
  for (let i = 0; i < pointsLonLat.length; i++) {
    const [mx, my] = lonLatToMerc(pointsLonLat[i][0], pointsLonLat[i][1]);
    dv.setFloat32(i * 12, mx, true);
    dv.setFloat32(i * 12 + 4, my, true);
    dv.setUint32(i * 12 + 8, rgba, true);
  }
  const n = pointsLonLat.length;
  const inds = new Uint32Array(Math.max(0, (n - 1) * 2));
  for (let i = 0; i + 1 < n; i++) {
    inds[i * 2] = i;
    inds[i * 2 + 1] = i + 1;
  }
  const vb = device.createBuffer({
    size: verts.byteLength,
    usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(vb.getMappedRange()).set(new Uint8Array(verts));
  vb.unmap();
  const ib = device.createBuffer({
    size: inds.byteLength,
    usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    mappedAtCreation: true,
  });
  new Uint8Array(ib.getMappedRange()).set(new Uint8Array(inds.buffer));
  ib.unmap();
  return { vb, ib, indexCount: inds.length, kind, name: "overlay" };
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
let lastX = 0, lastY = 0;
canvas.addEventListener("pointerdown", (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointerup", () => { dragging = false; });
canvas.addEventListener("pointermove", (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  const mpp = metersPerPixel() * (devicePixelRatio || 1);
  const [mx, my] = projectCenter();
  const nx = mx - dx * mpp;
  const ny = my + dy * mpp;
  cam.lon = (nx / R) * (180 / Math.PI);
  cam.lat =
    (2 * Math.atan(Math.exp(ny / R)) - Math.PI / 2) * (180 / Math.PI);
});
canvas.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    const dz = e.deltaY > 0 ? -0.25 : 0.25;
    cam.zoom = Math.max(8, Math.min(12, cam.zoom + dz));
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
    // red outage span near Tulsa
    outageGpu = makeOverlayLine(
      [
        [-96.05, 36.12],
        [-95.95, 36.12],
        [-95.9, 36.18],
      ],
      0xffe74c3c,
      1
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
          new Uint8Array(mem.buffer, instance.exports.webmap_wasm_build_id_ptr(), 32)
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
    setStatus('<span class="ok">WebGPU ready</span>');
    const manifest = await loadManifest();
    cam.lon = manifest.center?.[0] ?? cam.lon;
    cam.lat = manifest.center?.[1] ?? cam.lat;
    cam.zoom = manifest.zoom ?? 10;
    await loadTiles(manifest);

    fiberGpu = makeOverlayLine(
      [
        [-96.1, 36.0],
        [-95.99, 36.15],
        [-95.85, 36.2],
        [-95.7, 36.05],
      ],
      0xff9b59b6,
      1
    );
    powerGpu = makeOverlayLine(
      [
        [-96.2, 36.1],
        [-96.0, 36.1],
        [-95.9, 35.95],
        [-95.8, 35.85],
      ],
      0xffe67e22,
      1
    );
    rebuildOverlays();
    await tryWasm();
    log("demo ready — pan/zoom the map");
    requestAnimationFrame(frame);
  } catch (e) {
    setStatus('<span class="err">' + e.message + "</span>");
    log(String(e.stack || e));
  }
})();
