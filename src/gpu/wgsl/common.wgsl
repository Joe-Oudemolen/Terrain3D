// Shared helpers: PCG hash, gradient noise, Catmull-Rom bicubic.

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn hash2(x: i32, y: i32, seed: u32) -> u32 {
  return pcg(bitcast<u32>(x) + pcg(bitcast<u32>(y) + pcg(seed)));
}

fn gradient(x: i32, y: i32, seed: u32) -> vec2<f32> {
  let a = f32(hash2(x, y, seed)) * (6.283185307 / 4294967296.0);
  return vec2<f32>(cos(a), sin(a));
}

/** 2D gradient noise, roughly in [-0.7, 0.7]. */
fn gnoise(p: vec2<f32>, seed: u32) -> f32 {
  let i = floor(p);
  let f = p - i;
  let ix = i32(i.x);
  let iy = i32(i.y);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(gradient(ix, iy, seed), f);
  let b = dot(gradient(ix + 1, iy, seed), f - vec2<f32>(1.0, 0.0));
  let c = dot(gradient(ix, iy + 1, seed), f - vec2<f32>(0.0, 1.0));
  let d = dot(gradient(ix + 1, iy + 1, seed), f - vec2<f32>(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** Catmull-Rom (a = -0.5) weights for taps at offsets -1,0,+1,+2. Mirrors core/sample.ts. */
fn catmull_rom(t: f32) -> vec4<f32> {
  let t2 = t * t;
  let t3 = t2 * t;
  return vec4<f32>(
    -0.5 * t3 + t2 - 0.5 * t,
    1.5 * t3 - 2.5 * t2 + 1.0,
    -1.5 * t3 + 2.0 * t2 + 0.5 * t,
    0.5 * t3 - 0.5 * t2
  );
}

/** Bicubic sample of a row-major height buffer at world meters; indices clamp to the grid edge. */
fn bicubic(src: ptr<storage, array<f32>, read>, width: i32, height: i32, cell: f32, w: vec2<f32>) -> f32 {
  let uv = w / cell;
  let fl = floor(uv);
  let i = i32(fl.x);
  let j = i32(fl.y);
  let wx = catmull_rom(uv.x - fl.x);
  let wz = catmull_rom(uv.y - fl.y);
  var sum = 0.0;
  for (var dz = 0; dz < 4; dz++) {
    let cz = clamp(j - 1 + dz, 0, height - 1);
    var row = 0.0;
    for (var dx = 0; dx < 4; dx++) {
      let cx = clamp(i - 1 + dx, 0, width - 1);
      row += wx[dx] * (*src)[cz * width + cx];
    }
    sum += wz[dz] * row;
  }
  return sum;
}
