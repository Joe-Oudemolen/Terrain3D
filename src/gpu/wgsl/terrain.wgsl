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

const OCTAVES = 5;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.size || gid.y >= u.size) { return; }
  let wpos = vec2<f32>(f32(gid.x), f32(gid.y)) * u.cell; // world meters
  let q = wpos / u.baseWavelength + u.offset;
  // Broad warped uplands establish the map's structure before local detail.
  // Warping bends hill chains and valley corridors without uniformly roughening them.
  let warp = vec2<f32>(gnoise(q * 0.35, u.seed + 7u), gnoise(q * 0.35 + vec2<f32>(19.1, 8.7), u.seed + 29u));
  let p = q + warp * 0.9;
  let regional = clamp(0.5 + gnoise(p * 0.45, u.seed + 71u), 0.0, 1.0);
  let hills = clamp(0.5 + 0.85 * gnoise(p * 0.85, u.seed + 101u) + 0.15 * gnoise(p * 1.7, u.seed + 307u), 0.0, 1.0);
  let upland = pow(smoothstep(0.23, 0.86, hills), 1.0 + u.flatExp * 0.4);
  let ridge = pow(clamp(1.0 - abs(gnoise(p * 1.2, u.seed + 503u)) * 1.4142, 0.0, 1.0), 3.0);
  // Nested ridges provide 250–1200 m spurs and knolls. Fine ridges follow the
  // stronger parent ridges, so this produces connected relief rather than uniform bumps.
  var ridgePos = p * 2.4;
  var ridgeWeight = 1.0;
  var ridgeAmp = 1.0;
  var ridgeSum = 0.0;
  var ridgeNorm = 0.0;
  for (var o = 0u; o < 3u; o++) {
    let r = max(0.0, 1.0 - abs(gnoise(ridgePos, u.seed + 1201u + o * 137u)) * 1.4142);
    let signal = pow(r, 1.4 + u.ridgeMix) * ridgeWeight;
    ridgeSum += ridgeAmp * signal;
    ridgeNorm += ridgeAmp;
    ridgeWeight = clamp(signal * 1.8, 0.0, 1.0);
    ridgeAmp *= 0.45;
    ridgePos = vec2<f32>(ridgePos.x * 0.8 - ridgePos.y * 0.6, ridgePos.x * 0.6 + ridgePos.y * 0.8) * 2.03 + vec2<f32>(7.3, 19.1);
  }
  let reliefMask = smoothstep(0.03, 0.55, upland);
  var detailPos = p * 2.0;
  var amp = 1.0;
  var detail = 0.0;
  var norm = 0.0;
  for (var o = 0; o < OCTAVES; o++) {
    detail += amp * gnoise(detailPos, u.seed + 907u + u32(o) * 101u);
    norm += amp;
    amp *= u.gain;
    detailPos = detailPos * 2.0 + vec2<f32>(17.3, 9.1);
  }
  let grade = 0.065 * (1.0 - wpos.y / u.world);
  var n = 0.015 + grade + 0.09 * regional;
  n += upland * (0.48 + 0.22 * regional + 0.22 * u.ridgeMix * ridge);
  // Lower rolling foothills break up broad corridors without filling them with sharp ridges.
  let foothills = clamp(0.5 + 0.8 * gnoise(p * 2.1, u.seed + 601u), 0.0, 1.0);
  n += 0.11 * foothills * foothills * (0.35 + 0.65 * upland);
  n += 0.30 * u.ridgeMix * reliefMask * (ridgeSum / ridgeNorm - 0.45);
  n += detail / norm * (0.03 + 0.15 * u.gain) * (0.15 + 0.85 * reliefMask);
  n = clamp(n, 0.0, 1.0);
  if (u.island != 0u) {
    let d = min(min(wpos.x, wpos.y), min(u.world - wpos.x, u.world - wpos.y));
    let s = smoothstep(0.0, u.coastWidth, d);
    n = n * s - 0.05 * (1.0 - s);
  }
  outH[gid.y * u.size + gid.x] = (n - u.seaLevel) * u.height;
}
