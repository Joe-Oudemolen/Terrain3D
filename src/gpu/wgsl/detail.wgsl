// Full-res tile pass: bicubic upsample of the base terrain plus world-space fBm detail,
// faded by the bilinearly sampled detailMask. Uses helpers from common.wgsl.

struct Uniforms {
  tileSize: u32,
  seed: u32,
  tw: i32,       // terrain width
  th: i32,
  mw: i32,       // mask width
  mh: i32,
  tcell: f32,
  mcell: f32,
  origin: vec2<f32>, // tile origin, world meters
  spacing: f32,
  amplitude: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> terrain: array<f32>;
@group(0) @binding(2) var<storage, read> mask: array<f32>;
@group(0) @binding(3) var<storage, read_write> outH: array<f32>;

const OCTAVES = 5;       // wavelengths 64, 32, 16, 8, 4 m
const WAVELENGTH0 = 64.0;

fn mask_bilinear(w: vec2<f32>) -> f32 {
  let uv = w / u.mcell;
  let fl = floor(uv);
  let t = uv - fl;
  let i = i32(fl.x);
  let j = i32(fl.y);
  let x0 = clamp(i, 0, u.mw - 1);
  let x1 = clamp(i + 1, 0, u.mw - 1);
  let z0 = clamp(j, 0, u.mh - 1);
  let z1 = clamp(j + 1, 0, u.mh - 1);
  let a = mix(mask[z0 * u.mw + x0], mask[z0 * u.mw + x1], t.x);
  let b = mix(mask[z1 * u.mw + x0], mask[z1 * u.mw + x1], t.x);
  return mix(a, b, t.y);
}

/** fBm in world coordinates, so adjacent tiles agree exactly. Peak is about +-amplitude. */
fn detail(w: vec2<f32>) -> f32 {
  var sum = 0.0;
  var amp = 1.0;
  var total = 0.0;
  var wl = WAVELENGTH0;
  for (var o = 0; o < OCTAVES; o++) {
    sum += amp * gnoise(w / wl, u.seed + u32(o) * 101u);
    total += amp;
    amp *= 0.5;
    wl *= 0.5;
  }
  return u.amplitude * 1.4 * sum / total;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.tileSize || gid.y >= u.tileSize) { return; }
  let w = u.origin + vec2<f32>(f32(gid.x), f32(gid.y)) * u.spacing;
  var h = bicubic(&terrain, u.tw, u.th, u.tcell, w);
  let m = mask_bilinear(w);
  if (m > 0.0) {
    h += m * detail(w);
  }
  outH[gid.y * u.tileSize + gid.x] = h;
}
