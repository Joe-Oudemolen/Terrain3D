struct Uniforms {
  size: u32,
  seed: u32,
  cell: f32,
  world: f32,
  offset: vec2<f32>,
  baseWavelength: f32,
  gain: f32,
  ridgeMix: f32,
  flatExp: f32,
  seaLevel: f32,
  height: f32,
  island: u32,
  coastWidth: f32,
  pad0: f32,
  pad1: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read_write> outH: array<f32>;

const OCTAVES = 7;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.size || gid.y >= u.size) { return; }
  let wpos = vec2<f32>(f32(gid.x), f32(gid.y)) * u.cell; // world meters
  var p = wpos / u.baseWavelength + u.offset;
  var amp = 1.0;
  var smooth_sum = 0.0;
  var ridge_sum = 0.0;
  var norm = 0.0;
  for (var o = 0; o < OCTAVES; o++) {
    let n = gnoise(p, u.seed + u32(o) * 101u) * 1.4142;
    smooth_sum += amp * n;
    let r = 1.0 - abs(n);
    ridge_sum += amp * r * r;
    norm += amp;
    amp *= u.gain;
    p = p * 2.0 + vec2<f32>(17.3, 9.1);
  }
  let smooth01 = clamp(smooth_sum / norm * 0.5 + 0.5, 0.0, 1.0);
  let ridge01 = clamp(ridge_sum / norm, 0.0, 1.0);
  var n = mix(smooth01, ridge01, u.ridgeMix);
  n = pow(n, u.flatExp);
  if (u.island != 0u) {
    let d = min(min(wpos.x, wpos.y), min(u.world - wpos.x, u.world - wpos.y));
    let s = smoothstep(0.0, u.coastWidth, d);
    n = n * s - 0.05 * (1.0 - s);
  }
  outH[gid.y * u.size + gid.x] = (n - u.seaLevel) * u.height;
}
