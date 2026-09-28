// Terrain: reads the heights written by the Blender side (bake/terrain.py) and builds the
// height function for physics plus the GPU textures and clipmap meshes. Coordinates are three.js (y up);
// Blender (x, y, z) maps to (x, z, -y).
import * as THREE from 'three';

async function inflate(buf) {
  const ds = new DecompressionStream('deflate');
  const out = new Response(new Blob([buf]).stream().pipeThrough(ds));
  return new Uint8Array(await out.arrayBuffer());
}

export async function loadTerrain(base = 'data/') {
  const meta = await (await fetch(base + 'terrain.json')).json();
  const [raw, rraw, roadsJ] = await Promise.all([
    fetch(base + 'height.bin').then((r) => r.arrayBuffer()).then(inflate),
    fetch(base + 'road.bin').then((r) => r.arrayBuffer()).then(inflate),
    fetch(base + 'roads.json').then((r) => r.json()),
  ]);
  const n = meta.n;
  const d = new Int16Array(raw.buffer, raw.byteOffset, n * n);
  const H = new Float32Array(n * n);
  const k = (meta.hmax - meta.hmin) / 65535;
  for (let j = 0; j < n; j++) {
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc = (acc + d[j * n + i]) & 0xffff;   // undo the 16-bit wrapped delta encoding
      H[j * n + i] = meta.hmin + acc * k;
    }
  }
  const cell = meta.size / (n - 1), half = meta.size / 2;

  // For physics and placement: bilinear height lookup at three.js (x, z)
  function height(x, z) {
    let fx = (x + half) / cell, fy = (-z + half) / cell;
    fx = Math.min(Math.max(fx, 0), n - 1.001); fy = Math.min(Math.max(fy, 0), n - 1.001);
    const i = fx | 0, j = fy | 0, u = fx - i, v = fy - j, o = j * n + i;
    const a = H[o], b = H[o + 1], c = H[o + n], e = H[o + n + 1];
    return (a + (b - a) * u) * (1 - v) + (c + (e - c) * u) * v;
  }
  function normal(x, z, out = new THREE.Vector3()) {
    const s = cell;
    const hx = height(x + s, z) - height(x - s, z);
    const hz = height(x, z + s) - height(x, z - s);
    return out.set(-hx, 2 * s, -hz).normalize();
  }

  const roads = new Roads(roadsJ);
  const road = (x, z) => roads.nearest(x, z);

  // GPU: height (R32F, nearest; bilinear in the shader) and normals (RGBA8, linear)
  const hTex = new THREE.DataTexture(H, n, n, THREE.RedFormat, THREE.FloatType);
  hTex.needsUpdate = true;
  const nrm = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const o = j * n + i;
    const hx = H[j * n + Math.min(i + 1, n - 1)] - H[j * n + Math.max(i - 1, 0)];
    const hy = H[Math.min(j + 1, n - 1) * n + i] - H[Math.max(j - 1, 0) * n + i];
    // Blender-space normal (-hx, -hy, 2cell) to three.js (x, z, -y)
    let nx = -hx, ny = 2 * cell, nz = hy;
    const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    nrm[o * 4] = (nx * 0.5 + 0.5) * 255; nrm[o * 4 + 1] = (ny * 0.5 + 0.5) * 255;
    nrm[o * 4 + 2] = (nz * 0.5 + 0.5) * 255; nrm[o * 4 + 3] = 255;
  }
  const nTex = new THREE.DataTexture(nrm, n, n, THREE.RGBAFormat);
  nTex.magFilter = THREE.LinearFilter; nTex.minFilter = THREE.LinearMipmapLinearFilter;
  nTex.generateMipmaps = true; nTex.needsUpdate = true;

  // Road field (half-float RGBA: lateral distance, arc length mod 64, road index, Jigokudani strength)
  const rf = new Uint16Array(rraw.buffer, rraw.byteOffset, n * n * 4);
  const rTex = new THREE.DataTexture(rf, n, n, THREE.RGBAFormat, THREE.HalfFloatType);
  rTex.needsUpdate = true;
  return { meta, height, normal, road, roads, hTex, nTex, rTex };
}

// Terrain GLSL (height, normal, road coordinates), shared across shaders
export const terrainGLSL = /* glsl */`
uniform sampler2D uH; uniform sampler2D uN; uniform sampler2D uRoad;
uniform float uTN; uniform float uHalf;
float tH(vec2 xz){
  vec2 f = vec2(xz.x + uHalf, -xz.y + uHalf) / uHalf * 0.5 * (uTN - 1.0);
  f = clamp(f, vec2(0.0), vec2(uTN - 1.001));
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  float a = texelFetch(uH, i, 0).r, b = texelFetch(uH, i + ivec2(1,0), 0).r;
  float c = texelFetch(uH, i + ivec2(0,1), 0).r, d = texelFetch(uH, i + ivec2(1,1), 0).r;
  return mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
}
vec3 tN(vec2 xz){
  vec2 uv = vec2(xz.x + uHalf, -xz.y + uHalf) / (2.0 * uHalf);
  return normalize(texture2D(uN, uv).xyz * 2.0 - 1.0);
}
// Road field: x = lateral distance (positive to the left of travel), y = arc length (mod 64), z = road index, w = Jigokudani strength.
// Interpolate the 4 texels manually so the value doesn't jump at the seam where y wraps every 64 m
vec4 roadField(vec2 xz){
  vec2 f = vec2(xz.x + uHalf, -xz.y + uHalf) / uHalf * 0.5 * (uTN - 1.0);
  f = clamp(f, vec2(0.0), vec2(uTN - 1.001));
  ivec2 i = ivec2(floor(f)); vec2 t = f - vec2(i);
  vec4 a = texelFetch(uRoad, i, 0), b = texelFetch(uRoad, i + ivec2(1, 0), 0);
  vec4 c = texelFetch(uRoad, i + ivec2(0, 1), 0), d = texelFetch(uRoad, i + ivec2(1, 1), 0);
  b.y += round((a.y - b.y) / 64.0) * 64.0; c.y += round((a.y - c.y) / 64.0) * 64.0; d.y += round((a.y - d.y) / 64.0) * 64.0;
  vec4 r = mix(mix(a, b, t.x), mix(c, d, t.x), t.y);
  r.z = a.z;
  return r;
}
vec2 roadUV(vec2 xz){ return roadField(xz).xy; }
`;

export function terrainUniforms(T) {
  return {
    uH: { value: T.hTex }, uN: { value: T.nTex }, uRoad: { value: T.rTex },
    uTN: { value: T.meta.n }, uHalf: { value: T.meta.size / 2 },
  };
}

// Clipmap: LEVELS rings of a CN x CN grid. Innermost spacing STEP0 m, doubling per level.
// Areas covered by the finer level are cut out; the coarser edge is sunk slightly to hide cracks.
const CN = 224, HOLE = 108;
function clipGeometry(step, hole) {
  const n = CN, half = n / 2, hh = hole / 2;
  const pos = new Float32Array((n + 1) * (n + 1) * 3), dip = new Float32Array((n + 1) * (n + 1));
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const k = j * (n + 1) + i, gx = i - half, gz = j - half;
    pos[k * 3] = gx * step; pos[k * 3 + 2] = gz * step;
    if (hole > 0) dip[k] = Math.max(0, (hh + 2 - Math.max(Math.abs(gx), Math.abs(gz))) / 2) * step * 0.6;
  }
  const idx = [];
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    if (hole > 0 && Math.max(Math.abs(i - half + 0.5), Math.abs(j - half + 0.5)) < hh) continue;
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    idx.push(a, c, b, b, c, d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(pos.length).map((_, i) => i % 3 === 1 ? 1 : 0), 3));
  g.setAttribute('aDip', new THREE.BufferAttribute(dip, 1));
  g.setIndex(idx);
  return g;
}

export function buildClipmap(makeMaterial, levels = 7, step0 = 0.5) {
  const group = new THREE.Group(), meshes = [];
  for (let k = 0; k < levels; k++) {
    const step = step0 * 2 ** k;
    const m = new THREE.Mesh(clipGeometry(step, k === 0 ? 0 : HOLE), makeMaterial(step, k));
    m.frustumCulled = false; m.receiveShadow = true; m.userData.step = step;
    group.add(m); meshes.push(m);
  }
  group.userData.follow = (p) => {
    for (const m of meshes) {
      const s = m.userData.step * 2;
      m.position.set(Math.round(p.x / s) * s, 0, Math.round(p.z / s) * s);
    }
  };
  return group;
}

// Road network (vehicle side): centerlines sampled every 2 m, binned into a 16 m grid for nearest-road queries
export class Roads {
  constructor(list) {
    this.list = list.map((r) => ({ ...r, pts: r.pts.map(([x, y, z, s]) => ({ x, y, z, s })) }));
    this.cell = 16; this.grid = new Map();
    this.list.forEach((r, ri) => {
      const n = r.pts.length;
      for (let i = 0; i < n - (r.closed ? 0 : 1); i++) {
        const a = r.pts[i], b = r.pts[(i + 1) % n];
        const x0 = Math.floor(Math.min(a.x, b.x) / this.cell) - 1, x1 = Math.floor(Math.max(a.x, b.x) / this.cell) + 1;
        const z0 = Math.floor(Math.min(a.z, b.z) / this.cell) - 1, z1 = Math.floor(Math.max(a.z, b.z) / this.cell) + 1;
        for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
          const k = gx * 8192 + gz;
          (this.grid.get(k) || this.grid.set(k, []).get(k)).push(ri * 65536 + i);
        }
      }
    });
    // Rim-road segments are specified by bearing (degrees); convert them to arc length
    const rim = this.list[0];
    rim.zones = rim.zones.map((z) => {
      const t = z.at * Math.PI / 180; let best = 0, bd = 1e9;
      rim.pts.forEach((p) => { const d = Math.hypot(p.x - 330 * Math.cos(t), -p.z - 330 * Math.sin(t)); if (d < bd) { bd = d; best = p.s; } });
      return { ...z, at: best };
    }).sort((a, b) => a.at - b.at);
    this.byName = Object.fromEntries(this.list.map((r, i) => [r.name, i]));
  }
  // Nearest road: { road, s, v (positive left), x, y, z, tx, tz (travel direction) }. Pass "only" to restrict it to that road
  nearest(x, z, only = -1) {
    const gx = Math.floor(x / this.cell), gz = Math.floor(z / this.cell);
    let best = null, bd = 1e18;
    for (let r = 0; r <= 3 && !best; r++) {
      for (let ix = gx - r; ix <= gx + r; ix++) for (let iz = gz - r; iz <= gz + r; iz++) {
        for (const code of this.grid.get(ix * 8192 + iz) || []) {
          const ri = Math.floor(code / 65536), i = code % 65536;
          if (only >= 0 && ri !== only) continue;
          const R = this.list[ri], n = R.pts.length, a = R.pts[i], b = R.pts[(i + 1) % n];
          const ex = b.x - a.x, ez = b.z - a.z, L2 = ex * ex + ez * ez || 1e-6;
          const u = Math.min(1, Math.max(0, ((x - a.x) * ex + (z - a.z) * ez) / L2));
          const px = a.x + ex * u, pz = a.z + ez * u, d2 = (x - px) ** 2 + (z - pz) ** 2;
          if (d2 < bd) {
            bd = d2; const L = Math.sqrt(L2);
            const sb = (i + 1 === n) ? R.length : b.s;
            best = { road: ri, s: a.s + (sb - a.s) * u, x: px, y: a.y + (b.y - a.y) * u, z: pz, tx: ex / L, tz: ez / L,
              v: ((x - px) * -ez + (z - pz) * ex) / L * -1 };
          }
        }
      }
    }
    if (!best) return { road: -1, s: 0, v: 99, x, y: 0, z, tx: 0, tz: 1 };
    best.d = Math.sqrt(bd);
    return best;
  }
  // Point at arc length s on road ri (loop roads wrap around)
  at(ri, s) {
    const R = this.list[ri], n = R.pts.length;
    if (R.closed) s = ((s % R.length) + R.length) % R.length; else s = Math.min(Math.max(s, 0), R.length);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (R.pts[m].s <= s) lo = m; else hi = m; }
    const a = R.pts[lo], b = R.closed && lo === n - 1 ? R.pts[0] : R.pts[hi];
    const sb = (b === R.pts[0] && lo === n - 1) ? R.length : b.s;
    const u = sb > a.s ? (s - a.s) / (sb - a.s) : 0;
    const ex = b.x - a.x, ez = b.z - a.z, L = Math.hypot(ex, ez) || 1;
    return { x: a.x + ex * u, y: a.y + (b.y - a.y) * u, z: a.z + ez * u, tx: ex / L, tz: ez / L };
  }
  zone(ri, s) {
    const R = this.list[ri], zs = R?.zones || [];
    let z = zs[zs.length - 1];
    for (const q of zs) if (q.at <= s) z = q;
    return z && { ...z, title: R.title };
  }
}
