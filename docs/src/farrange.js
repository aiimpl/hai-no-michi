// Distant ranges: a 12 km square, 8 m grid heightfield eroded by bake/farland.py, drawn as a coarse mesh (32 m grid) with
// fine normals (8 m). Coloring follows the near outer rim: forest in gullies, rock on ridges and steep slopes, grass up high.
// Joins the near terrain (1 km square) at its edge; the inner part sits beneath the near terrain.
import * as THREE from 'three';

async function inflate(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

export async function makeFarRange(base, patch, noiseGLSL) {
  const meta = await (await fetch(base + 'far.json')).json();
  const raw = await inflate(await (await fetch(base + 'far.bin')).arrayBuffer());
  const n = meta.n, d = new Int16Array(raw.buffer, raw.byteOffset, n * n), H = new Float32Array(n * n);
  const k = (meta.hmax - meta.hmin) / 65535;
  for (let j = 0; j < n; j++) { let a = 0; for (let i = 0; i < n; i++) { a = (a + d[j * n + i]) & 0xffff; H[j * n + i] = meta.hmin + a * k; } }
  const half = meta.size / 2, cell = meta.size / (n - 1);
  // Normals (three.js axes: x, up, -y) and ridge/gully (curvature) packed into one texture
  const tex = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const o = j * n + i, at = (a, b) => H[Math.min(n - 1, Math.max(0, b)) * n + Math.min(n - 1, Math.max(0, a))];
    const hx = at(i + 1, j) - at(i - 1, j), hy = at(i, j + 1) - at(i, j - 1);
    let nx = -hx, ny = 2 * cell, nz = hy; const l = Math.hypot(nx, ny, nz); nx /= l; ny /= l; nz /= l;
    const lap = (at(i + 3, j) + at(i - 3, j) + at(i, j + 3) + at(i, j - 3) - 4 * H[o]) / (9 * cell * cell);
    tex[o * 4] = (nx * 0.5 + 0.5) * 255; tex[o * 4 + 1] = (ny * 0.5 + 0.5) * 255; tex[o * 4 + 2] = (nz * 0.5 + 0.5) * 255;
    tex[o * 4 + 3] = Math.max(0, Math.min(255, 128 + lap * 9000));
  }
  const nTex = new THREE.DataTexture(tex, n, n, THREE.RGBAFormat);
  nTex.magFilter = THREE.LinearFilter; nTex.minFilter = THREE.LinearMipmapLinearFilter; nTex.generateMipmaps = true; nTex.anisotropy = 8; nTex.needsUpdate = true;
  // Mesh: 8 m grid out to 2.4 km from the map edge, 32 m grid beyond. The inner part (under the near terrain) is not built
  function gridMesh(step, inner, outer) {
    const m = Math.floor((n - 1) / step) + 1;
    const pos = [], uv = [], map = new Int32Array(m * m).fill(-1);
    const inside = (gi, gj) => { const x = -half + gi * cell, y = -half + gj * cell, c = Math.max(Math.abs(x), Math.abs(y)); return c >= inner - step * cell && c <= outer + step * cell; };
    for (let j = 0; j < m; j++) for (let i = 0; i < m; i++) {
      const gi = i * step, gj = j * step;
      if (!inside(gi, gj)) continue;
      map[j * m + i] = pos.length / 3;
      pos.push(-half + gi * cell, H[gj * n + gi], -(-half + gj * cell));
      uv.push(gi / (n - 1), gj / (n - 1));
    }
    const idx = [];
    for (let j = 0; j < m - 1; j++) for (let i = 0; i < m - 1; i++) {
      const a = map[j * m + i], b = map[j * m + i + 1], c = map[(j + 1) * m + i], e = map[(j + 1) * m + i + 1];
      if (a < 0 || b < 0 || c < 0 || e < 0) continue;
      idx.push(a, b, c, b, e, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }
  const gNear = gridMesh(1, 860, 2600), gFar = gridMesh(4, 2600, half);
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0 });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uFarN = { value: nTex };
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vFarUv; varying vec3 vFarW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFarUv = uv; vFarW = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nuniform sampler2D uFarN; varying vec2 vFarUv; varying vec3 vFarW;\n${noiseGLSL}`)
      .replace('#include <normal_fragment_begin>', `float faceDirection = 1.0;
        vec4 fn = texture2D(uFarN, vFarUv);
        vec3 wN = normalize(fn.xyz * 2.0 - 1.0);
        vec3 normal = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
        vec3 nonPerturbedNormal = normal;`)
      .replace('#include <color_fragment>', `
        vec4 fq = texture2D(uFarN, vFarUv);
        vec3 wn2 = normalize(fq.xyz * 2.0 - 1.0);
        float curv = (fq.w - 0.502) * 2.0;                 // positive = gully
        vec2 P = vFarW.xz;
        float slope = wn2.y, h0 = vFarW.y;
        float c1 = ffbm(P * 0.09 + 3.0), c2 = fnoise(P * 0.35 + 9.0);
        vec3 canopy = mix(vec3(0.008, 0.014, 0.007), vec3(0.018, 0.03, 0.013), c1 * 0.6 + c2 * 0.4);
        canopy = mix(canopy, vec3(0.04, 0.052, 0.022), smoothstep(0.62, 0.8, ffbm(P * 0.008 + 17.0)) * 0.6);
        float highK = smoothstep(420.0, 560.0, h0 + 60.0 * (ffbm(P * 0.004) - 0.5) - curv * 200.0);
        vec3 meadow = mix(vec3(0.05, 0.06, 0.022), vec3(0.1, 0.095, 0.04), ffbm(P * 0.02 + 51.0));
        float strata = ffbm(vec2(dot(P, vec2(0.6, 0.8)) * 0.02, h0 * 0.12));
        vec3 rock = mix(vec3(0.04, 0.038, 0.035), vec3(0.085, 0.08, 0.072), strata);
        float ridgeK = smoothstep(0.05, 0.4, -curv);
        float steepK = smoothstep(0.62, 0.45, slope);
        vec3 col = mix(canopy, meadow, highK * (1.0 - smoothstep(0.0, 0.3, curv)));
        col = mix(col, rock, clamp(steepK * 0.9 + ridgeK * (0.1 + 0.7 * highK), 0.0, 1.0) * smoothstep(0.35, 0.55, ffbm(P * 0.01 + 5.0) + steepK * 0.4));
        // don't draw the inner part (under the near terrain)
        if (max(abs(P.x), abs(P.y)) < 1000.0) discard;
        diffuseColor.rgb = col;`);
  };
  mat.customProgramCacheKey = () => 'farland';
  patch?.(mat);
  const mesh = new THREE.Group();
  for (const g of [gNear, gFar]) { const m = new THREE.Mesh(g, mat); m.frustumCulled = false; mesh.add(m); }
  return { mesh, update: () => {} };
}
