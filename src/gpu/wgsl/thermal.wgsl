// Thermal erosion (talus / scree) as a two-pass gather over 8 neighbours. No atomics.
// Pass 1 (outflow): each cell stores ratio = moved / sum(excess), where excess to a lower
//   neighbour is the height drop beyond the talus slope and moved = rate * maxExcess / 2.
// Pass 2 (apply): each cell receives ratio_j * excess_ji from every higher neighbour j and
//   loses ratio_i * excess_ij to every lower neighbour, so material is conserved exactly.

struct Uniforms {
  n: u32,
  l: f32,      // cell size, m
  talus: f32,  // max stable slope (rise / run)
  rate: f32,   // fraction of the worst excess moved per pass
}

@group(0) @binding(0) var<uniform> u: Uniforms;
@group(0) @binding(1) var<storage, read> bIn: array<f32>;
@group(0) @binding(2) var<storage, read_write> bOut: array<f32>;
@group(0) @binding(3) var<storage, read_write> ratio: array<f32>;

const OFFS = array<vec2<i32>, 8>(
  vec2<i32>(-1, 0), vec2<i32>(1, 0), vec2<i32>(0, -1), vec2<i32>(0, 1),
  vec2<i32>(-1, -1), vec2<i32>(1, -1), vec2<i32>(-1, 1), vec2<i32>(1, 1),
);

fn inside(p: vec2<i32>) -> bool {
  let n = i32(u.n);
  return p.x >= 0 && p.y >= 0 && p.x < n && p.y < n;
}

fn idx(p: vec2<i32>) -> u32 { return u32(p.y) * u.n + u32(p.x); }

// Height drop from `hi` to `lo` beyond the talus slope over neighbour offset k.
fn excess(hi: f32, lo: f32, k: u32) -> f32 {
  let dist = select(u.l, u.l * 1.41421356, k >= 4u);
  return max(0.0, hi - lo - u.talus * dist);
}

@compute @workgroup_size(8, 8)
fn outflow(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.n || gid.y >= u.n) { return; }
  let p = vec2<i32>(gid.xy);
  let h = bIn[idx(p)];
  var total = 0.0;
  var worst = 0.0;
  for (var k = 0u; k < 8u; k++) {
    let q = p + OFFS[k];
    if (!inside(q)) { continue; }
    let e = excess(h, bIn[idx(q)], k);
    total += e;
    worst = max(worst, e);
  }
  var r = 0.0;
  if (total > 0.0) { r = u.rate * 0.5 * worst / total; }
  ratio[idx(p)] = r;
}

@compute @workgroup_size(8, 8)
fn apply(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= u.n || gid.y >= u.n) { return; }
  let p = vec2<i32>(gid.xy);
  let i = idx(p);
  let h = bIn[i];
  let rOwn = ratio[i];
  var delta = 0.0;
  for (var k = 0u; k < 8u; k++) {
    let q = p + OFFS[k];
    if (!inside(q)) { continue; }
    let j = idx(q);
    let hn = bIn[j];
    delta += ratio[j] * excess(hn, h, k) - rOwn * excess(h, hn, k);
  }
  bOut[i] = h + delta;
}
