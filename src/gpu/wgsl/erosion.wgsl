// Hydraulic erosion, virtual-pipe shallow-water model (Mei et al. 2007).
// One scalar per buffer. Heights/depths in meters, flux in m^3/s, speed in m/s.
// Each entry point is one pass of a simulation step; the host dispatches
// flux -> water -> erode -> advect (flux-form sediment transport). Rain is applied in flux (budget) + water (volume),
// evaporation at the end of advect. No atomics: every invocation writes only its own cell.

struct Uniforms {
  n: u32,
  l: f32,          // cell size, m
  dt: f32,         // time step, s
  kFlux: f32,      // dt * A * g / l
  rainDt: f32,     // rain depth per step, m
  evap: f32,       // 1 - Ke*dt
  kc: f32,         // sediment capacity constant
  ksDt: f32,       // dissolve fraction per step
  kdDt: f32,       // deposit fraction per step
  depthRef: f32,   // water depth at which capacity saturates, m
  pad0: f32,
  minSin: f32,     // capacity floor on flat ground
  dMin: f32,       // min depth used to derive velocity, m
  maxErode: f32,   // max terrain removed per step, m
  creep: f32,      // hillslope diffusion per step, D*dt/l^2
  pad1: f32,
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> bOut: array<f32>;
@group(0) @binding(3) var<storage, read_write> water: array<f32>;
@group(0) @binding(4) var<storage, read_write> sed: array<f32>;
@group(0) @binding(5) var<storage, read_write> sedOut: array<f32>;
@group(0) @binding(6) var<storage, read_write> fL: array<f32>;
@group(0) @binding(7) var<storage, read_write> fR: array<f32>;
@group(0) @binding(8) var<storage, read_write> fT: array<f32>;
@group(0) @binding(9) var<storage, read_write> fB: array<f32>;
@group(0) @binding(10) var<storage, read_write> speed: array<f32>; // |v|, m/s
@group(0) @binding(11) var<storage, read_write> wPrev: array<f32>; // depth at step start (+ rain), m

fn idx(x: i32, z: i32) -> u32 { return u32(z) * u.n + u32(x); }

fn inside(x: i32, z: i32) -> bool {
  let n = i32(u.n);
  return x >= 0 && z >= 0 && x < n && z < n;
}

// Out-of-bounds neighbours: terrain = own terrain, water = 0, so water drains off the map.
fn headDiff(h: f32, b: f32, x: i32, z: i32) -> f32 {
  if (!inside(x, z)) { return h - b; }
  let j = idx(x, z);
  return h - (bIn[j] + water[j]);
}

@compute @workgroup_size(8, 8)
fn flux(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.n || gid.y >= u.n) { return; }
  let x = i32(gid.x);
  let z = i32(gid.y);
  let i = idx(x, z);
  let b = bIn[i];
  let w = water[i] + u.rainDt;
  let h = b + water[i]; // rain is uniform, so it cancels out of head differences
  let l = max(0.0, fL[i] + u.kFlux * headDiff(h, b, x - 1, z));
  let r = max(0.0, fR[i] + u.kFlux * headDiff(h, b, x + 1, z));
  let t = max(0.0, fT[i] + u.kFlux * headDiff(h, b, x, z - 1));
  let bo = max(0.0, fB[i] + u.kFlux * headDiff(h, b, x, z + 1));
  let total = (l + r + t + bo) * u.dt;
  var k = 1.0;
  if (total > 0.0) { k = min(1.0, w * u.l * u.l / total); }
  fL[i] = l * k;
  fR[i] = r * k;
  fT[i] = t * k;
  fB[i] = bo * k;
}

fn fluxAt(x: i32, z: i32, dir: u32) -> f32 {
  if (!inside(x, z)) { return 0.0; }
  let j = idx(x, z);
  switch dir {
    case 0u: { return fL[j]; }
    case 1u: { return fR[j]; }
    case 2u: { return fT[j]; }
    default: { return fB[j]; }
  }
}

@compute @workgroup_size(8, 8)
fn waterStep(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.n || gid.y >= u.n) { return; }
  let x = i32(gid.x);
  let z = i32(gid.y);
  let i = idx(x, z);
  let inL = fluxAt(x - 1, z, 1u); // left neighbour's rightward flux
  let inR = fluxAt(x + 1, z, 0u);
  let inT = fluxAt(x, z - 1, 3u);
  let inB = fluxAt(x, z + 1, 2u);
  let outL = fL[i];
  let outR = fR[i];
  let outT = fT[i];
  let outB = fB[i];
  let w1 = water[i] + u.rainDt;
  let w2 = max(0.0, w1 + u.dt * (inL + inR + inT + inB - outL - outR - outT - outB) / (u.l * u.l));
  water[i] = w2;
  wPrev[i] = w1;
  let d = max(0.5 * (w1 + w2), u.dMin);
  let qx = 0.5 * (inL - outL + outR - inR);
  let qz = 0.5 * (inT - outT + outB - inB);
  speed[i] = length(vec2<f32>(qx, qz)) / (u.l * d);
}

fn terrainAt(x: i32, z: i32) -> f32 {
  let n = i32(u.n);
  return bIn[idx(clamp(x, 0, n - 1), clamp(z, 0, n - 1))];
}

@compute @workgroup_size(8, 8)
fn erodeStep(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.n || gid.y >= u.n) { return; }
  let x = i32(gid.x);
  let z = i32(gid.y);
  let i = idx(x, z);
  let b = bIn[i];
  // Sobel gradient: smooth and nearly isotropic, so a single deposit does not change its
  // own cell's slope (which would feed ripple/antidune growth). Its blind spot, the
  // checkerboard mode, is the one soil creep below damps fastest.
  let nw = terrainAt(x - 1, z - 1);
  let ne = terrainAt(x + 1, z - 1);
  let sw = terrainAt(x - 1, z + 1);
  let se = terrainAt(x + 1, z + 1);
  let gx = (ne + 2.0 * terrainAt(x + 1, z) + se) - (nw + 2.0 * terrainAt(x - 1, z) + sw);
  let gz = (sw + 2.0 * terrainAt(x, z + 1) + se) - (nw + 2.0 * terrainAt(x, z - 1) + ne);
  let tanA = length(vec2<f32>(gx, gz)) / (8.0 * u.l);
  let sinA = max(tanA / sqrt(1.0 + tanA * tanA), u.minSin);
  let cap = u.kc * sinA * speed[i] * clamp(water[i] / u.depthRef, 0.0, 1.0);
  let s = sed[i];
  var delta: f32; // terrain change (+ deposit, - erode)
  if (cap > s) {
    delta = -min(u.ksDt * (cap - s), u.maxErode);
  } else {
    delta = u.kdDt * (s - cap);
  }
  // Soil creep: conservative linear diffusion (zero-flux at the map edge). It damps
  // grid-scale incision noise so channels organise into valleys instead of 1-cell rills.
  let lap = terrainAt(x - 1, z) + terrainAt(x + 1, z) + terrainAt(x, z - 1) + terrainAt(x, z + 1) - 4.0 * b;
  bOut[i] = b + delta + u.creep * lap;
  sed[i] = s - delta;
}

// Fraction of cell j's start-of-step water that left through its pipe toward `dir`.
// Sender and receiver evaluate the same expression, so transport is exactly conservative.
fn outFraction(j: u32, dir: u32) -> f32 {
  let total = (fL[j] + fR[j] + fT[j] + fB[j]) * u.dt;
  let denom = max(wPrev[j] * u.l * u.l, total);
  if (denom <= 0.0) { return 0.0; }
  var f: f32;
  switch dir {
    case 0u: { f = fL[j]; }
    case 1u: { f = fR[j]; }
    case 2u: { f = fT[j]; }
    case 3u: { f = fB[j]; }
    default: { f = fL[j] + fR[j] + fT[j] + fB[j]; } // all directions
  }
  return f * u.dt / denom;
}

fn inflow(x: i32, z: i32, dir: u32) -> f32 {
  if (!inside(x, z)) { return 0.0; }
  let j = idx(x, z);
  return sed[j] * outFraction(j, dir);
}

// Sediment transport, upwind and in flux form: each cell sends its suspended sediment
// along with its water, in proportion to the water that left through each pipe. This
// replaces a semi-Lagrangian gather, which loses most of the sediment where sheet flow
// converges into channels. Sediment carried through the map edge leaves with the water.
// Ends the step with evaporation.
@compute @workgroup_size(8, 8)
fn advect(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.n || gid.y >= u.n) { return; }
  let x = i32(gid.x);
  let z = i32(gid.y);
  let i = idx(x, z);
  let stay = sed[i] * (1.0 - outFraction(i, 4u));
  let gained = inflow(x - 1, z, 1u) + inflow(x + 1, z, 0u) + inflow(x, z - 1, 3u) + inflow(x, z + 1, 2u);
  sedOut[i] = stay + gained;
  water[i] = water[i] * u.evap;
}
