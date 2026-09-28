// Ground cover: ferns (baked frond texture bent into arcs, arranged radially), grass tufts (bundles of tapering blades), rocks and pumice (baked in Blender).
// Reads the placement tables (ferns/grass/rocks/pumice.bin) and each frame picks only the instances near the camera and in view.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { noiseGLSL } from './forest.js';

async function inflate(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Float32Array(await new Response(s).arrayBuffer());
}

function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// Fern: 11 fronds rising diagonally from the base with drooping tips. The frond texture is the bottom-right cell of the 2x2 atlas
function fernGeometry(seed) {
  const r = rng(seed), pos = [], uv = [], nrm = [], col = [], idx = [];
  const n = 17, seg = 6;
  for (let f = 0; f < n; f++) {
    // outer fronds are long and low, inner young fronds short and upright
    const inner = f % 3 === 0;
    const az = (f / n) * Math.PI * 2 + (r() - 0.5) * 0.6;
    const len = (inner ? 0.6 : 0.95) + r() * 0.45, rise = (inner ? 1.35 : 0.8) + r() * 0.35, w = 0.9 + r() * 0.2;
    const d = new THREE.Vector3(Math.cos(az), 0, Math.sin(az)), side = new THREE.Vector3(-d.z, 0, d.x);
    const tw = (r() - 0.5) * 0.6;                        // frond twist
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const s = i / seg;
      // arc: rises, then droops
      const h = Math.sin(s * Math.PI * 0.9) * 0.55 * rise - s * s * 0.25;
      const c = d.clone().multiplyScalar(s * len).add(new THREE.Vector3(0, h, 0));
      const up = new THREE.Vector3(0, 1, 0).applyAxisAngle(d, tw * s);
      const sd = side.clone().applyAxisAngle(d, tw * s);
      for (const v of [-0.5, 0.5]) {
        const p = c.clone().addScaledVector(sd, v * w * len * 0.9);
        pos.push(p.x, p.y, p.z);
        uv.push(0.5 + s * 0.5, 0.5 + (0.5 - v) * 0.5);   // top of the cell is +y (v' counts from the top of the image)
        const nn = up.clone().multiplyScalar(0.6).add(d.clone().multiplyScalar(0.4)).normalize();
        nrm.push(nn.x, nn.y, nn.z);
        col.push(0.35 + 0.65 * s, s, r());
      }
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

// Grass tuft: 18 thin blades, dark at the base, pale yellow-green at the tips
function grassGeometry(seed) {
  const r = rng(seed), pos = [], nrm = [], col = [], idx = [];
  const n = 18, seg = 4;
  for (let b = 0; b < n; b++) {
    const az = r() * Math.PI * 2, lean = 0.15 + r() * 0.55, h = 0.36 + r() * 0.36, w = 0.018 + r() * 0.01;
    const d = new THREE.Vector3(Math.cos(az), 0, Math.sin(az)), side = new THREE.Vector3(-d.z, 0, d.x);
    const o = new THREE.Vector3((r() - 0.5) * 0.08, 0, (r() - 0.5) * 0.08);
    const base = pos.length / 3;
    for (let i = 0; i <= seg; i++) {
      const s = i / seg;
      const c = o.clone().addScaledVector(d, lean * h * s * s).add(new THREE.Vector3(0, h * s * (1 - 0.25 * lean * s), 0));
      const ww = w * (1 - s * 0.92);
      for (const v of [-1, 1]) {
        const p = c.clone().addScaledVector(side, v * ww);
        pos.push(p.x, p.y, p.z);
        const nn = d.clone().multiplyScalar(0.3).add(new THREE.Vector3(0, 1, 0)).normalize();
        nrm.push(nn.x, nn.y, nn.z);
        col.push(s, s, r());
      }
    }
    for (let i = 0; i < seg; i++) { const a = base + i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}

function plantMaterial(U, { map = null, grass = false } = {}) {
  const m = new THREE.MeshStandardMaterial({ map, side: THREE.DoubleSide, roughness: 0.75, metalness: 0, alphaTest: map ? 0.5 : 0 });
  if (map) m.alphaToCoverage = true;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec3 aCol; uniform float uTime; varying vec3 vCol; varying float vR;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float ph = dot(ip.xz, vec2(0.37, 0.21));
        float sw = aCol.g * aCol.g * ${grass ? '0.06' : '0.035'};
        transformed.x += sin(uTime * 1.9 + ph) * sw; transformed.z += cos(uTime * 1.6 + ph * 1.3) * sw;
        vCol = aCol; vR = fract(sin(ph * 17.3) * 431.7);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vCol; varying float vR; uniform vec3 uSunColor;\n${noiseGLSL}`)
      .replace('#include <color_fragment>', grass ? `#include <color_fragment>
        vec3 g0 = vec3(0.06, 0.07, 0.03), g1 = mix(vec3(0.42, 0.45, 0.16), vec3(0.52, 0.5, 0.22), vR);
        diffuseColor.rgb = mix(g0, g1, smoothstep(0.0, 0.9, vCol.r)) * (0.8 + 0.4 * vCol.b);`
        : `#include <color_fragment>
        diffuseColor.rgb *= mix(0.25, 1.05, vCol.r) * mix(vec3(0.9, 1.0, 0.85), vec3(1.05, 1.0, 0.8), vR) * 0.68;`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        float tr = pow(max(dot(-geometryViewDir, uSunView), 0.0), 3.0) * 0.7 + 0.04;
        reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * tr * vCol.r * shadowF;`);
  };
  m.customProgramCacheKey = () => (grass ? 'grass' : 'fern');
  return m;
}

export async function loadGroundCover(base, U, patch, T, foliageColor) {
  const tl = new THREE.TextureLoader();
  const [ferns, grass, rocks, pumice, rg, rbase, rnrm] = await Promise.all([
    ...['ferns', 'grass', 'rocks', 'pumice'].map((n) => fetch(base + n + '.bin').then((r) => r.arrayBuffer()).then(inflate)),
    new GLTFLoader().loadAsync(base + 'rocks.glb'), tl.loadAsync(base + 'rock_base.webp'), tl.loadAsync(base + 'rock_normal.webp'),
  ]);
  for (const t of [rbase, rnrm]) { t.flipY = false; t.anisotropy = 8; }
  rbase.colorSpace = THREE.SRGBColorSpace;
  const rockMat = patch(new THREE.MeshStandardMaterial({ map: rbase, normalMap: rnrm, roughness: 0.85, metalness: 0 }));
  const fernMat = patch(plantMaterial(U, { map: foliageColor }));
  const grassMat = patch(plantMaterial(U, { grass: true }));
  const rockGeo = []; rg.scene.traverse((c) => { if (c.isMesh) rockGeo[+c.name.replace('rock', '')] = c.geometry; });

  const group = new THREE.Group();
  const layers = [];
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3();
  // Per type: placement, shape variants, material, draw distance
  function layer(raw, geos, mat, range, cap, opts = {}) {
    const N = raw.length / 6, mats = new Float32Array(N * 16), sub = new Uint8Array(N);
    const R = rng(N);
    for (let i = 0; i < N; i++) {
      const x = raw[i * 6], y = raw[i * 6 + 1], z = raw[i * 6 + 2], rot = raw[i * 6 + 3], s = raw[i * 6 + 4], k = raw[i * 6 + 5];
      sub[i] = opts.byKind ? k : Math.floor(R() * geos.length);
      const tilt = opts.tilt || 0;
      _e.set((R() - 0.5) * tilt, rot, (R() - 0.5) * tilt); _q.setFromEuler(_e);
      const sy = opts.flatY ? s * (0.7 + R() * 0.5) : s;
      _s.set(s, sy, s * (0.8 + R() * 0.4));
      _p.set(x, T.height(x, z) - (opts.sink || 0) * s, z);
      _m.compose(_p, _q, _s).toArray(mats, i * 16);
    }
    const meshes = geos.map((g) => {
      const m = new THREE.InstancedMesh(g, mat, cap);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0; group.add(m);
      return m;
    });
    const L = { raw, N, mats, sub, meshes, range, cap };
    layers.push(L);
    return L;
  }
  layer(ferns, [fernGeometry(1), fernGeometry(2), fernGeometry(3)], fernMat, 95, 2500);
  layer(grass, [grassGeometry(4), grassGeometry(5)], grassMat, 70, 2500);
  const rockL = layer(rocks, rockGeo.slice(0, 3), rockMat, 260, 900, { byKind: true, tilt: 0.5, sink: 0.12, flatY: true });
  const pumL = layer(pumice, [rockGeo[3]], rockMat, 90, 800, { tilt: 1.2, sink: 0.05 });

  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), sphere = new THREE.Sphere();
  function update(camera) {
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); frustum.setFromProjectionMatrix(pm);
    const c = camera.position;
    for (const L of layers) {
      const cnt = L.meshes.map(() => 0), r2 = L.range * L.range;
      for (let i = 0; i < L.N; i++) {
        const x = L.raw[i * 6], z = L.raw[i * 6 + 2];
        const dx = x - c.x, dz = z - c.z;
        if (dx * dx + dz * dz > r2) continue;
        sphere.center.set(x, L.mats[i * 16 + 13], z); sphere.radius = 2 * L.raw[i * 6 + 4];
        if (!frustum.intersectsSphere(sphere)) continue;
        const k = L.sub[i], m = L.meshes[k];
        if (cnt[k] >= L.cap) continue;
        m.instanceMatrix.array.set(L.mats.subarray(i * 16, i * 16 + 16), cnt[k] * 16);
        cnt[k]++;
      }
      L.meshes.forEach((m, k) => { m.count = cnt[k]; m.instanceMatrix.needsUpdate = true; });
    }
  }

  // rocks also go into the static shadow map (all of them, once)
  function shadowCasters() {
    const out = [];
    for (const L of [rockL, pumL]) {
      L.meshes.forEach((m, k) => {
        const idx = []; for (let i = 0; i < L.N; i++) if (L.sub[i] === k) idx.push(i);
        const s = new THREE.InstancedMesh(m.geometry, rockMat, idx.length);
        idx.forEach((i, j) => s.instanceMatrix.array.set(L.mats.subarray(i * 16, i * 16 + 16), j * 16));
        out.push(s);
      });
    }
    return out;
  }

  return { group, update, shadowCasters };
}
