/**
 * P4.12 — optional WebGPU glass-lens chrome (screen-space SDF).
 *
 * Draws soft shadow + frosted fill + dual rim + north tick on the map
 * canvas under the Canvas2D schematic. Interaction and schematic paint
 * stay in fiber_magnifier / fiber_schematic (ADR-016 / ADR-021).
 *
 * Enable with ?glass_gpu=1 (default off — experiment).
 */

import { GLASS_LENS } from "./glass_tokens.js";

/** @param {string|null|undefined} [search] */
export function parseGlassGpuQuery(search = null) {
  try {
    const q = new URLSearchParams(
      search ?? (typeof location !== "undefined" ? location.search : "")
    );
    const v = (q.get("glass_gpu") || q.get("glassgpu") || "").toLowerCase();
    if (v === "1" || v === "true" || v === "on" || v === "yes") return true;
    if (v === "0" || v === "false" || v === "off" || v === "no") return false;
    return false;
  } catch {
    return false;
  }
}

/**
 * Parse CSS rgba()/rgb()/#hex into premultiplied-ready linear sRGB 0..1.
 * @param {string} s
 * @param {number[]} [fallback]
 * @returns {[number, number, number, number]}
 */
export function parseCssColorRgba(s, fallback = [0, 0, 0, 1]) {
  if (!s || typeof s !== "string") return /** @type {[number,number,number,number]} */ (fallback.slice());
  const t = s.trim();
  const hex = t.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) {
      h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    }
    const r = parseInt(h.slice(0, 2), 16) / 255;
    const g = parseInt(h.slice(2, 4), 16) / 255;
    const b = parseInt(h.slice(4, 6), 16) / 255;
    const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    return [r, g, b, a];
  }
  const m = t.match(
    /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i
  );
  if (m) {
    return [
      Math.min(1, Number(m[1]) / 255),
      Math.min(1, Number(m[2]) / 255),
      Math.min(1, Number(m[3]) / 255),
      m[4] != null ? Math.min(1, Number(m[4])) : 1,
    ];
  }
  return /** @type {[number,number,number,number]} */ (fallback.slice());
}

const GLASS_LENS_WGSL = /* wgsl */ `
struct LensUniforms {
  // device-pixel resolution of the canvas
  resolution: vec2f,
  // lens center in device pixels
  center: vec2f,
  // outer radius in device pixels
  radius: f32,
  // pad to 32-byte offset so fill (vec4) is 16-aligned
  _pad0: f32,
  _pad1: f32,
  _pad2: f32,
  fill: vec4f,
  rim: vec4f,
  rim_inner: vec4f,
  shadow: vec4f,
  tick: vec4f,
};

@group(0) @binding(0) var<uniform> u: LensUniforms;

struct VSOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f, // pixel coords (device)
};

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VSOut {
  // Fullscreen triangle covering clip space
  var p = array<vec2f, 3>(
    vec2f(-1.0, -1.0),
    vec2f( 3.0, -1.0),
    vec2f(-1.0,  3.0)
  );
  var o: VSOut;
  let clip = p[vi];
  o.pos = vec4f(clip, 0.0, 1.0);
  // clip xy -> pixel (origin top-left, y down like CSS)
  let ndc = clip * 0.5 + vec2f(0.5, 0.5);
  o.uv = vec2f(ndc.x * u.resolution.x, (1.0 - ndc.y) * u.resolution.y);
  return o;
}

fn sd_circle(p: vec2f, r: f32) -> f32 {
  return length(p) - r;
}

@fragment
fn fs_main(i: VSOut) -> @location(0) vec4f {
  let p = i.uv - u.center;
  let r = u.radius;
  if (r < 1.0) {
    return vec4f(0.0);
  }

  // Soft outer shadow (offset slightly down-right)
  let sh_off = vec2f(2.0, 3.0);
  let d_sh = sd_circle(p - sh_off, r);
  let shadow_a = (1.0 - smoothstep(-6.0, 10.0, d_sh)) * u.shadow.a * 0.85;

  // Main disc with soft edge
  let d = sd_circle(p, r);
  let fill_a = (1.0 - smoothstep(-1.5, 1.2, d)) * u.fill.a;

  // Outer rim band (~2.5 px)
  let rim_w = 2.8;
  let outer_band = abs(d);
  let rim_a = (1.0 - smoothstep(0.0, rim_w, outer_band)) * u.rim.a;
  // only on the rim, not deep inside
  let rim_mask = smoothstep(-rim_w * 2.0, -0.5, d) * (1.0 - smoothstep(0.5, rim_w + 1.0, d));
  let rim_contrib = rim_a * rim_mask;

  // Inner hairline rim
  let d_in = sd_circle(p, r - 3.2);
  let inner_band = abs(d_in);
  let inn_a = (1.0 - smoothstep(0.0, 1.4, inner_band)) * u.rim_inner.a;
  let inn_mask = select(0.0, 1.0, d < -1.0);
  let inn_contrib = inn_a * inn_mask;

  // North tick at top of rim
  let tick_half_w = 1.1;
  let tick_y0 = -r + 1.5;
  let tick_y1 = -r + 10.0;
  let in_tick_x = abs(p.x) < tick_half_w + 0.5;
  let in_tick_y = p.y > tick_y0 - 0.5 && p.y < tick_y1 + 0.5;
  var tick_a = 0.0;
  if (in_tick_x && in_tick_y) {
    let ax = 1.0 - smoothstep(tick_half_w - 0.3, tick_half_w + 0.6, abs(p.x));
    let ay = 1.0 - smoothstep(0.0, 0.8, max(tick_y0 - p.y, p.y - tick_y1));
    tick_a = ax * ay * u.tick.a;
  }

  // Soft specular crescent (subtle glass feel)
  let nrm = normalize(p + vec2f(0.0001));
  let spec = max(0.0, dot(nrm, normalize(vec2f(-0.35, -0.85))));
  let disc = 1.0 - smoothstep(-1.0, 1.0, d);
  let gloss = pow(spec, 12.0) * 0.12 * disc;

  // Composite (premultiplied-friendly; host uses standard alpha blend)
  var rgb = u.fill.rgb * fill_a;
  rgb = rgb + u.shadow.rgb * shadow_a * (1.0 - fill_a * 0.5);
  rgb = rgb + u.rim.rgb * rim_contrib;
  rgb = rgb + u.rim_inner.rgb * inn_contrib;
  rgb = rgb + u.tick.rgb * tick_a;
  rgb = rgb + vec3f(gloss);

  var a = max(shadow_a, fill_a);
  a = max(a, rim_contrib);
  a = max(a, inn_contrib);
  a = max(a, tick_a);
  a = min(1.0, a + gloss);

  if (a < 0.004) {
    discard;
  }
  // Un-premultiply-ish: store straight alpha for src-alpha blend
  let inv = select(0.0, 1.0 / max(a, 0.001), a > 0.001);
  // Prefer token colors with controlled alpha rather than over-bright
  let out_rgb = clamp(rgb * inv, vec3f(0.0), vec3f(1.0));
  // Re-mix fill as dominant when inside disc
  let final_rgb = mix(out_rgb, u.fill.rgb, fill_a * 0.92);
  let final_a = a;
  return vec4f(final_rgb, final_a);
}
`;

/**
 * @param {{
 *   device: GPUDevice,
 *   format: GPUTextureFormat,
 *   log?: (s: string) => void,
 * }} opts
 */
export function createGlassLensGpu(opts) {
  const { device, format, log = () => {} } = opts;

  const module = device.createShaderModule({
    label: "glass_lens_gpu",
    code: GLASS_LENS_WGSL,
  });

  // WGSL uniform layout (16-byte align for vec4):
  // resolution vec2 @0, center vec2 @8, radius @16, pad3xf32 @20–28,
  // fill @32, rim @48, rim_inner @64, shadow @80, tick @96 → 112 used, 128 alloc
  const UNIFORM_BYTES = 128;
  const uniformBuf = device.createBuffer({
    label: "glass_lens_uniforms",
    size: UNIFORM_BYTES,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });

  const bindGroupLayout = device.createBindGroupLayout({
    entries: [
      {
        binding: 0,
        visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT,
        buffer: { type: "uniform" },
      },
    ],
  });
  const bindGroup = device.createBindGroup({
    layout: bindGroupLayout,
    entries: [{ binding: 0, resource: { buffer: uniformBuf } }],
  });

  const pipeline = device.createRenderPipeline({
    label: "glass_lens_pipeline",
    layout: device.createPipelineLayout({
      bindGroupLayouts: [bindGroupLayout],
    }),
    vertex: { module, entryPoint: "vs_main" },
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

  const fill = parseCssColorRgba(GLASS_LENS.bg, [0.05, 0.06, 0.09, 0.94]);
  const rim = parseCssColorRgba(GLASS_LENS.rim, [0.63, 0.78, 1.0, 0.55]);
  const rimInner = parseCssColorRgba(GLASS_LENS.rimInner, [1, 1, 1, 0.12]);
  const shadow = parseCssColorRgba(GLASS_LENS.shadow, [0, 0, 0, 0.35]);
  const tick = parseCssColorRgba(GLASS_LENS.rimTick, [1, 1, 1, 0.35]);

  const staging = new ArrayBuffer(UNIFORM_BYTES);
  const f32 = new Float32Array(staging);

  /**
   * @param {GPURenderPassEncoder} pass
   * @param {{
   *   devCx: number,
   *   devCy: number,
   *   rDev: number,
   *   canvasW: number,
   *   canvasH: number,
   * }} layout device-pixel lens geometry + canvas size
   */
  function draw(pass, layout) {
    if (!layout || !(layout.rDev > 0)) return;
    const w = layout.canvasW | 0;
    const h = layout.canvasH | 0;
    if (w < 1 || h < 1) return;

    // resolution @0
    f32[0] = w;
    f32[1] = h;
    // center @8
    f32[2] = layout.devCx;
    f32[3] = layout.devCy;
    // radius @16 + pad @20–28
    f32[4] = layout.rDev;
    f32[5] = 0;
    f32[6] = 0;
    f32[7] = 0;
    // fill @32
    f32[8] = fill[0];
    f32[9] = fill[1];
    f32[10] = fill[2];
    f32[11] = fill[3];
    // rim @48
    f32[12] = rim[0];
    f32[13] = rim[1];
    f32[14] = rim[2];
    f32[15] = rim[3];
    // rim_inner @64
    f32[16] = rimInner[0];
    f32[17] = rimInner[1];
    f32[18] = rimInner[2];
    f32[19] = rimInner[3];
    // shadow @80
    f32[20] = shadow[0];
    f32[21] = shadow[1];
    f32[22] = shadow[2];
    f32[23] = shadow[3];
    // tick @96
    f32[24] = tick[0];
    f32[25] = tick[1];
    f32[26] = tick[2];
    f32[27] = tick[3];

    device.queue.writeBuffer(uniformBuf, 0, staging);
    pass.setPipeline(pipeline);
    pass.setBindGroup(0, bindGroup);
    pass.draw(3);
  }

  function destroy() {
    try {
      uniformBuf.destroy();
    } catch {
      /* ignore */
    }
  }

  log("glass_lens_gpu: pipeline ready (opt-in ?glass_gpu=1)");

  return {
    draw,
    destroy,
    /** Token colors used by the shader (for tests / HUD). */
    colors: { fill, rim, rimInner, shadow, tick },
    get enabled() {
      return true;
    },
  };
}
