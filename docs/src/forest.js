// Forest: instances the Blender trees (trees_lod0/1.glb) according to the placement table (trees.bin).
// Each frame, trees in view are split into near / mid LOD by distance; the boundary is cross-faded with dithered discard.
// Shadows draw every tree once, in mid-LOD form, into the static shadow map (shadows.js).
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { shadowGLSL } from './shadows.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const KINDS = ['spruce', 'hemlock', 'young', 'tall'];
const HEIGHT = [24, 20, 8.5, 31];
const R0 = 48, R1 = 190, R2 = 2600, BAND = 8, BAND1 = 24;   // near and mid radii, draw limit, cross-fade widths (m)

async function inflate(buf) {
  const s = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Float32Array(await new Response(s).arrayBuffer());
}

export const noiseGLSL = /* glsl */`
float fhash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float fnoise(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fhash(i), fhash(i + vec2(1, 0)), u.x), mix(fhash(i + vec2(0, 1)), fhash(i + vec2(1, 1)), u.x), u.y); }
float ffbm(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 5; i++){ v += a * fnoise(p); p = p * 2.03 + 17.1; a *= 0.5; } return v; }
float bayer4(vec2 p){ ivec2 q = ivec2(mod(p, 4.0)); int i = q.x + q.y * 4;
  int b[16] = int[16](0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5); return (float(b[i]) + 0.5) / 16.0; }
// Dithered crossfade: positive f keeps fraction f, negative f discards the complementary 1-|f| (the two sides fill each other)
// Canopy field: one conical crown, 3-5 m across, per cell of a jittered grid. pxPerCrown is how many pixels one crown covers.
// Returns: x = crown height (0 gap .. 1 treetop), yz = crown surface orientation (xz, for lighting), w = color variation.
// Below 2-6 pixels per crown, fade to the average (height 0.5, no orientation) to avoid distant shimmer
vec4 crownField(vec2 p, float pxPerCrown){
  vec2 q = p / 4.2, i = floor(q), f = fract(q);
  float best = 0.0, tint = 0.5; vec2 g = vec2(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++){
    vec2 o = vec2(x, y), c = o + vec2(fhash(i + o), fhash(i + o + 7.1)) * 0.8 + 0.1;
    vec2 d = f - c; float r = 0.42 + 0.22 * fhash(i + o + 3.3);
    float h = 1.0 - length(d) / r;
    if (h > best) { best = h; g = d / max(length(d), 1e-3); tint = fhash(i + o + 11.0); }
  }
  float k = 1.0 - smoothstep(2.0, 6.0, pxPerCrown);
  return vec4(mix(clamp(best, 0.0, 1.0), 0.5, k), g * (1.0 - k) * smoothstep(0.0, 0.3, best), mix(tint, 0.5, k));
}
bool fadeOut(float f){ float b = bayer4(gl_FragCoord.xy); return f > 0.0 ? (f < 0.999 && b > f) : (b <= 1.0 + f); }
`;

// Leaves: baked cluster cards (alpha-tested). Darker inside the crown, translucent against the light, tips sway in the wind
function leafMaterial(tex, U) {
  const m = new THREE.MeshStandardMaterial({
    map: tex.color, normalMap: tex.normal, normalScale: new THREE.Vector2(1.0, 1.0),
    alphaTest: 0.5, side: THREE.DoubleSide, roughness: 0.78, metalness: 0,
  });
  m.alphaToCoverage = true;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
        attribute vec3 aCol; attribute float aFade;
        uniform float uTime; varying vec3 vCol; varying float vFade; varying float vTint;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vec3 ip = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
        float ph = dot(ip.xz, vec2(0.13, 0.071));
        float sway = aCol.g * (0.05 + 0.012 * transformed.y);
        transformed.x += sin(uTime * 1.3 + ph + transformed.y * 0.21) * sway;
        transformed.z += cos(uTime * 1.07 + ph * 1.7 + transformed.y * 0.17) * sway * 0.8;
        vCol = aCol; vFade = aFade; vTint = fract(sin(ph * 91.7) * 4375.5);`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vCol; varying float vFade; varying float vTint;
        uniform vec3 uSunColor; ${noiseGLSL}`)
      .replace('#include <alphatest_fragment>', `#include <alphatest_fragment>
        if (fadeOut(vFade)) discard;
        // Dither out leaves right in front of the camera (keeps the car visible even when the camera is inside a tree)
        if (bayer4(gl_FragCoord.xy) > smoothstep(3.0, 9.0, vViewPosition.z)) discard;`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        // Darker toward the crown interior; per-tree and per-card tint variation (yellow-green to blue-green)
        float ao = mix(0.09, 1.0, pow(vCol.r, 1.3));
        vec3 warm = vec3(1.0, 1.0, 0.72), cool = vec3(0.72, 0.9, 0.95);
        float v = fract(vTint + vCol.b * 0.6);
        diffuseColor.rgb *= 0.46 * ao * mix(cool, warm, v) * (0.6 + 0.55 * vCol.b);`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
        // Backlit translucency: leaves glow with the sun behind them; weaker for inner leaves and in shadow
        float tr = pow(max(dot(-geometryViewDir, uSunView), 0.0), 3.0) * 0.7 + 0.04;
        reflectedLight.directDiffuse += diffuseColor.rgb * uSunColor * tr * vCol.r * shadowF;`);
  };
  m.customProgramCacheKey = () => 'leaf';
  return m;
}

// Trunk: bark is procedural in the shader (UVs in meters). Dark grey-brown with vertical fissures
function barkMaterial(U, bleach = 0) {
  const m = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 aBark; attribute float aFade; varying vec2 vBark; varying float vFade;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvBark = aBark; vFade = aFade;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec2 vBark; varying float vFade;\n${noiseGLSL}`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        if (fadeOut(vFade)) discard;
        if (bayer4(gl_FragCoord.xy) > smoothstep(2.0, 7.0, vViewPosition.z)) discard;   // dither out trunks in front of the camera
        vec2 bp = vBark * vec2(7.0, 1.1);
        float ridge = 1.0 - abs(ffbm(bp + vec2(0.0, ffbm(bp * 0.5) * 1.5)) * 2.0 - 1.0);
        float fine = ffbm(vBark * vec2(26.0, 5.0));
        vec3 bark = mix(vec3(0.014, 0.012, 0.010), vec3(0.058, 0.05, 0.043), ridge * 0.8 + fine * 0.3);
        bark = mix(bark, vec3(0.035, 0.045, 0.025), smoothstep(0.62, 0.8, ffbm(vBark * vec2(3.0, 0.8) + 9.0)) * 0.5);   // moss
        diffuseColor.rgb = mix(bark, vec3(0.19, 0.18, 0.165) * (0.7 + 0.5 * ridge) + fine * 0.03, ${bleach.toFixed(2)});   // dead snags are bleached by the sun`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        { vec2 bp = vBark * vec2(7.0, 1.1);
          float hC = ffbm(bp);
          normal = normalize(normal + (dFdx(hC) * normalize(dFdx(-vViewPosition)) + dFdy(hC) * normalize(dFdy(-vViewPosition))) * -6.0 * faceDirection); }`);
  };
  m.customProgramCacheKey = () => 'bark' + bleach;
  return m;
}

// Far LOD: impostor cards (bake/impostor.py). Of the 8x8 hemisphere views, the 4 closest to the view direction are
// each reprojected from their capture direction and blended. Lighting uses the baked normals; shadows sample the static map.
function impostorMaterial(tex, U, shadowU, fogU) {
  return new THREE.ShaderMaterial({
    uniforms: Object.assign({ uCol: { value: tex.color }, uNrm: { value: tex.normal }, uCamPos: { value: new THREE.Vector3() } }, U, shadowU, fogU),
    vertexShader: /* glsl */`
      attribute float aKind; attribute float aFade;
      uniform vec3 uCamPos; uniform float uMirror;
      varying vec3 vPl; varying vec3 vView; varying float vKind; varying float vFade; varying vec3 vW; varying float vTint;
      varying mat3 vR;
      const float HK[4] = float[4](24.0, 20.0, 8.5, 31.0);
      void main(){
        mat4 im = instanceMatrix;
        float s = length(im[0].xyz);
        mat3 R = mat3(im[0].xyz / s, im[1].xyz / s, im[2].xyz / s);
        int k = int(aKind + 0.5);
        float H = HK[k] * s, S = H * 1.12;
        vec3 C = im[3].xyz + vec3(0.0, H * 0.5, 0.0);
        // In the mirrored reflection pass (uMirror = -1) build the card for the mirrored camera, then flip y
        vec3 camU = vec3(uCamPos.x, uCamPos.y * uMirror, uCamPos.z);
        vec3 vl = transpose(R) * normalize(camU - C);
        vl.y = max(vl.y, 0.02); vl = normalize(vl);
        vec3 Z = vl, Y = normalize(vec3(0.0, 1.0, 0.0) - Z * Z.y), X = cross(Y, Z);
        vec3 Pl = X * position.x + Y * position.y;
        vec3 Pw = C + R * (Pl * S);
        vPl = Pl; vView = vl; vKind = aKind; vFade = aFade; vW = Pw; vR = R;
        vTint = fract(sin(dot(im[3].xz, vec2(0.13, 0.071)) * 91.7) * 4375.5);
        gl_Position = projectionMatrix * viewMatrix * vec4(Pw.x, Pw.y * uMirror, Pw.z, 1.0);
      }`,
    side: THREE.DoubleSide,
    fragmentShader: /* glsl */`
      uniform sampler2D uCol, uNrm; uniform vec3 uSunColor; uniform vec3 uSunDirW;
      uniform vec3 uHemiSky, uHemiGround, uEnvAmb; uniform vec3 uFogColor; uniform float uFogDensity;
      varying vec3 vPl; varying vec3 vView; varying float vKind; varying float vFade; varying vec3 vW; varying float vTint;
      varying mat3 vR;
      ${shadowGLSL}
      ${noiseGLSL}
      const float G = 8.0;
      vec2 enc(vec3 d){ vec2 p = d.xz / (abs(d.x) + abs(d.y) + abs(d.z)); return vec2(p.x + p.y, p.x - p.y) * 0.5 + 0.5; }
      vec3 dec(vec2 e){ vec2 t = e * 2.0 - 1.0; vec2 p = vec2(t.x + t.y, t.x - t.y) * 0.5;
        return normalize(vec3(p.x, max(0.0, 1.0 - abs(p.x) - abs(p.y)), p.y)); }
      void main(){
        if (fadeOut(vFade)) discard;
        vec2 g = clamp(enc(vView) * G - 0.5, vec2(0.0), vec2(G - 1.001));
        vec2 i0 = floor(g), f = g - i0;
        int k = int(vKind + 0.5);
        vec2 slot = vec2(float(k % 2), float(k / 2)) * 0.5;
        vec4 col = vec4(0.0); vec3 nrm = vec3(0.0); float wsum = 0.0;
        for (int b = 0; b < 4; b++){
          vec2 o = vec2(float(b % 2), float(b / 2));
          vec2 fi = min(i0 + o, vec2(G - 1.0));
          float w = (o.x > 0.5 ? f.x : 1.0 - f.x) * (o.y > 0.5 ? f.y : 1.0 - f.y);
          vec3 dk = dec((fi + 0.5) / G);
          vec3 Yk = normalize(vec3(0.0, 1.0, 0.0) - dk * dk.y), Xk = cross(Yk, dk);
          vec2 uv = vec2(dot(vPl, Xk), dot(vPl, Yk)) + 0.5;
          if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) continue;
          vec2 a = slot + (fi + vec2(uv.x, 1.0 - uv.y)) / G * 0.5;
          vec4 c = texture2D(uCol, a);
          col += c * w; nrm += (texture2D(uNrm, a).xyz * 2.0 - 1.0) * c.a * w; wsum += w;
        }
        if (col.a < 0.5 * wsum || wsum < 0.01) discard;
        vec3 alb = col.rgb / max(col.a, 1e-3);
        vec3 warm = vec3(1.0, 1.0, 0.72), cool = vec3(0.72, 0.9, 0.95);
        alb *= mix(cool, warm, vTint) * 0.9 * 0.74;   // match near-LOD leaf brightness (baked 0.62 -> 0.46)
        vec3 N = normalize(vR * nrm);
        float sh = sunShadowAt(vW, N);
        float ndl = max(dot(N, uSunDirW), 0.0) * 0.85 + 0.15;
        vec3 amb = mix(uHemiGround, uHemiSky, N.y * 0.5 + 0.5);
        // Same scale as three's standard material: direct and sky light are Lambert (1/pi); uEnvAmb adds the environment reflection term
        vec3 c = alb * ((uSunColor * ndl * sh + amb) / 3.14159 + uEnvAmb);
        float fd = 1.0 - exp(-pow(uFogDensity * length(vW - cameraPosition), 2.0));
        c = mix(c, uFogColor, fd);
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
}

// Dead snags: a trunk with a broken top plus short dead stubs where branches fell (UVs in meters)
function snagGeometry(seed, stump = false) {
  let r = seed; const rnd = () => ((r = (r * 1664525 + 1013904223) >>> 0) / 4294967296);
  const parts = [];
  const H = stump ? 2.5 + rnd() * 4 : 9 + rnd() * 9;
  const r0 = 0.22 + rnd() * 0.16;
  const trunk = new THREE.CylinderGeometry(stump ? r0 * 0.7 : 0.05 + rnd() * 0.05, r0, H, 9, 12, true).translate(0, H / 2, 0);
  const p = trunk.attributes.position;
  for (let i = 0; i < p.count; i++) {       // bend slightly, more splintered toward the top
    const y = p.getY(i), t = y / H;
    p.setX(i, p.getX(i) + Math.sin(y * 0.4 + seed) * (0.2 + 0.5 * rnd() * 0) * t + t * t * (seed % 7 - 3) * 0.12);
    if (t > 0.97) p.setY(i, y - rnd() * (stump ? 1.2 : 0.8));     // jagged broken top
  }
  parts.push(trunk);
  for (let k = 0; k < (stump ? 2 : 5 + Math.floor(rnd() * 8)); k++) {
    const y = H * (0.35 + 0.55 * rnd()), l = 0.6 + rnd() * 1.6 * (1 - y / H), a = rnd() * Math.PI * 2;
    const b = new THREE.CylinderGeometry(0.012, 0.045, l, 5, 1, true).translate(0, l / 2, 0)
      .rotateZ(Math.PI / 2 - 0.25 - rnd() * 0.4).rotateY(a).translate(0, y, 0);
    parts.push(b);
  }
  const g = mergeGeometries(parts.map((q) => q.toNonIndexed()));
  const uv = new Float32Array(g.attributes.position.count * 2);
  for (let i = 0; i < g.attributes.position.count; i++) {
    const x = g.attributes.position.getX(i), z = g.attributes.position.getZ(i);
    uv[i * 2] = Math.atan2(z, x) * 0.3; uv[i * 2 + 1] = g.attributes.position.getY(i);
  }
  g.setAttribute('aBark', new THREE.BufferAttribute(uv, 2));
  g.setAttribute('aFade', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(1), 1));
  g.computeVertexNormals();
  return g;
}

function prepGeometry(g, leaves) {
  g = g.clone();
  if (leaves) {
    const c = g.getAttribute('color');
    const a = new Float32Array(c.count * 3);
    for (let i = 0; i < c.count; i++) { a[i * 3] = c.getX(i); a[i * 3 + 1] = c.getY(i); a[i * 3 + 2] = c.getZ(i); }
    g.setAttribute('aCol', new THREE.BufferAttribute(a, 3));
    g.deleteAttribute('color');
  } else {
    g.setAttribute('aBark', g.getAttribute('uv'));
    g.deleteAttribute('color');
  }
  return g;
}

export async function loadForest(base, U, patch, shadows, env) {
  const gl = new GLTFLoader(), tl = new THREE.TextureLoader();
  const [g0, g1, color, normal, raw, icol, inrm] = await Promise.all([
    gl.loadAsync(base + 'trees_lod0.glb'), gl.loadAsync(base + 'trees_lod1.glb'),
    tl.loadAsync(base + 'foliage_color.webp'), tl.loadAsync(base + 'foliage_normal.webp'),
    fetch(base + 'trees.bin').then((r) => r.arrayBuffer()).then(inflate),
    tl.loadAsync(base + 'impostor_color.webp'), tl.loadAsync(base + 'impostor_normal.webp'),
  ]);
  for (const t of [icol, inrm]) { t.flipY = false; t.anisotropy = 4; t.generateMipmaps = true; }
  icol.colorSpace = THREE.SRGBColorSpace;
  for (const t of [color, normal]) { t.flipY = false; t.anisotropy = 8; }
  color.colorSpace = THREE.SRGBColorSpace;
  const leafM = patch(leafMaterial({ color, normal }, U));
  const barkM = patch(barkMaterial(U));

  const N = raw.length / 6;
  const inst = { x: new Float32Array(N), y: new Float32Array(N), z: new Float32Array(N), rot: new Float32Array(N), s: new Float32Array(N), k: new Uint8Array(N) };
  const byKind = KINDS.map(() => []);
  for (let i = 0; i < N; i++) {
    inst.x[i] = raw[i * 6]; inst.y[i] = raw[i * 6 + 1] - 0.15; inst.z[i] = raw[i * 6 + 2];
    inst.rot[i] = raw[i * 6 + 3]; inst.s[i] = raw[i * 6 + 4]; inst.k[i] = raw[i * 6 + 5];
    byKind[inst.k[i]].push(i);
  }
  const mats = new Float32Array(N * 16);
  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), UPV = new THREE.Vector3(0, 1, 0);
  for (let i = 0; i < N; i++) {
    _q.setFromAxisAngle(UPV, inst.rot[i]); _s.setScalar(inst.s[i]); _p.set(inst.x[i], inst.y[i], inst.z[i]);
    _m.compose(_p, _q, _s).toArray(mats, i * 16);
  }

  const group = new THREE.Group();
  const find = (g, n) => { let o = null; g.scene.traverse((c) => { if (c.isMesh && c.name === n) o = c; }); return o; };
  const sets = [];           // [lod][kind] = { leaves, trunk, fade }
  const cap = [700, 4000];
  for (const [lod, g] of [[0, g0], [1, g1]]) {
    sets[lod] = KINDS.map((k) => {
      const lg = prepGeometry(find(g, `${k}_lod${lod}_leaves`).geometry, true);
      const tg = prepGeometry(find(g, `${k}_lod${lod}_trunk`).geometry, false);
      const n = Math.min(cap[lod], byKind[KINDS.indexOf(k)].length);
      const fade = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
      fade.setUsage(THREE.DynamicDrawUsage);
      lg.setAttribute('aFade', fade); tg.setAttribute('aFade', fade);
      const leaves = new THREE.InstancedMesh(lg, leafM, n), trunk = new THREE.InstancedMesh(tg, barkM, n);
      for (const m of [leaves, trunk]) { m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0; group.add(m); }
      return { leaves, trunk, fade, n };
    });
  }

  // Far impostors: all trees in a single instanced mesh (species as an attribute)
  const quad = new THREE.PlaneGeometry(1, 1);
  const impN = N;
  const aKind = new THREE.InstancedBufferAttribute(new Float32Array(impN), 1), aFadeI = new THREE.InstancedBufferAttribute(new Float32Array(impN), 1);
  aKind.setUsage(THREE.DynamicDrawUsage); aFadeI.setUsage(THREE.DynamicDrawUsage);
  quad.setAttribute('aKind', aKind); quad.setAttribute('aFade', aFadeI);
  const impMat = impostorMaterial({ color: icol, normal: inrm }, U, Object.assign({ uSunDirW: { value: shadows.sun } }, shadows.uniforms), env);
  const imp = new THREE.InstancedMesh(quad, impMat, impN);
  imp.instanceMatrix.setUsage(THREE.DynamicDrawUsage); imp.frustumCulled = false; imp.count = 0;
  group.add(imp);

  // Forest beyond the map (bake/farland.py): impostors only, static. Unpack 8 bytes per tree into one instanced mesh
  {
    const fr = await fetch(base + 'fartrees.bin').then((r) => r.arrayBuffer()).then(async (buf) => {
      const st = new Blob([buf]).stream().pipeThrough(new DecompressionStream('deflate'));
      return new Int16Array(await new Response(st).arrayBuffer());
    });
    const FN = fr.length / 4;
    const fq = new THREE.PlaneGeometry(1, 1);
    const fk = new Float32Array(FN), ff = new Float32Array(FN).fill(1);
    const far = new THREE.InstancedMesh(fq, impMat.clone(), FN);
    far.material.uniforms = impMat.uniforms;                    // share camera position and other uniforms
    for (let i = 0; i < FN; i++) {
      const w = fr[i * 4 + 3] & 0xffff, rot = (w & 255) / 256 * Math.PI * 2, sb = w >> 8;
      const sc = (sb & 63) / 63 * 1.6; fk[i] = sb >> 6;
      _q.setFromAxisAngle(UPV, rot); _s.setScalar(sc); _p.set(fr[i * 4] / 10, fr[i * 4 + 1] / 10, fr[i * 4 + 2] / 10);
      _m.compose(_p, _q, _s); far.setMatrixAt(i, _m);
    }
    fq.setAttribute('aKind', new THREE.InstancedBufferAttribute(fk, 1));
    fq.setAttribute('aFade', new THREE.InstancedBufferAttribute(ff, 1));
    far.frustumCulled = false;
    group.add(far);
  }

  // For shadows: draw every tree once in mid-LOD form
  const shadowSets = KINDS.map((k, ki) => {
    const idx = byKind[ki];
    const lg = find(g1, `${k}_lod1_leaves`).geometry, tg = find(g1, `${k}_lod1_trunk`).geometry;
    const L = new THREE.InstancedMesh(lg, leafM, idx.length), Tm = new THREE.InstancedMesh(tg, barkM, idx.length);
    idx.forEach((i, j) => { for (let q = 0; q < 16; q++) { L.instanceMatrix.array[j * 16 + q] = mats[i * 16 + q]; } });
    Tm.instanceMatrix.array.set(L.instanceMatrix.array);
    return { L, T: Tm };
  });

  const frustum = new THREE.Frustum(), pm = new THREE.Matrix4(), sphere = new THREE.Sphere();
  function update(camera) {
    pm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(pm);
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const cnt = [KINDS.map(() => 0), KINDS.map(() => 0)];
    let ic = 0;
    impMat.uniforms.uCamPos.value.copy(camera.position);
    const putI = (i, ki, f) => {
      imp.instanceMatrix.array.set(mats.subarray(i * 16, i * 16 + 16), ic * 16);
      aKind.array[ic] = ki; aFadeI.array[ic] = f; ic++;
    };
    for (let ki = 0; ki < KINDS.length; ki++) {
      const idx = byKind[ki], H = HEIGHT[ki];
      // Trees in the boundary band go into both LODs and are swapped by dithering (one side uses the inverted mask)
      let i = 0;
      const put = (lod, f) => {
        const S = sets[lod][ki], c = cnt[lod][ki];
        if (c >= S.n) return;
        S.leaves.instanceMatrix.array.set(mats.subarray(i * 16, i * 16 + 16), c * 16);
        S.fade.array[c] = f;
        cnt[lod][ki] = c + 1;
      };
      for (let j = 0; j < idx.length; j++) {
        i = idx[j];
        const s = inst.s[i];
        sphere.center.set(inst.x[i], inst.y[i] + H * s * 0.5, inst.z[i]); sphere.radius = H * s * 0.55;
        const dx = inst.x[i] - cx, dy = sphere.center.y - cy, dz = inst.z[i] - cz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (d > R2 || !frustum.intersectsSphere(sphere)) continue;
        if (d > R1) { putI(i, ki, 1); continue; }
        if (d > R1 - BAND1) { const t = (d - (R1 - BAND1)) / BAND1; put(1, 1 - t); putI(i, ki, -t); continue; }
        const r0 = R0 * (HEIGHT[ki] > 10 ? 1 : 0.6);
        if (d < r0 - BAND) put(0, 1);
        else if (d < r0) { const t = (d - (r0 - BAND)) / BAND; put(0, 1 - t); put(1, -t); }
        else put(1, 1);
      }
    }
    for (let lod = 0; lod < 2; lod++) for (let ki = 0; ki < KINDS.length; ki++) {
      const S = sets[lod][ki], c = cnt[lod][ki];
      S.leaves.count = S.trunk.count = c;
      S.trunk.instanceMatrix.array.set(S.leaves.instanceMatrix.array.subarray(0, c * 16));
      S.leaves.instanceMatrix.needsUpdate = S.trunk.instanceMatrix.needsUpdate = true;
      S.fade.needsUpdate = true;
    }
    imp.count = ic;
    imp.instanceMatrix.needsUpdate = aKind.needsUpdate = aFadeI.needsUpdate = true;
    cnt.push(ic);
    return cnt;
  }

  // Dead snags (Jigokudani): only a few hundred, so always draw all of them
  const sraw = await fetch(base + 'snags.bin').then((r) => r.arrayBuffer()).then(inflate);
  const snagM = patch(barkMaterial(U, 1));
  const SG = [snagGeometry(3), snagGeometry(11), snagGeometry(29), snagGeometry(47), snagGeometry(5, true)];
  const snags = SG.map((g, gi) => {
    const idx = []; for (let i = 0; i < sraw.length / 6; i++) if (i % SG.length === gi) idx.push(i);
    const m = new THREE.InstancedMesh(g, snagM, idx.length);
    idx.forEach((i, j) => {
      // tilt each one and vary its girth-to-height ratio
      const a = sraw[i * 6 + 3], lean = (Math.sin(i * 12.9898) * 0.5 + 0.5) * 0.18;
      _q.setFromEuler(new THREE.Euler(Math.cos(a * 3.1) * lean, a, Math.sin(a * 2.3) * lean));
      const sc = sraw[i * 6 + 4];
      _s.set(sc * (0.8 + 0.4 * ((i * 0.618) % 1)), sc, sc * (0.8 + 0.4 * ((i * 0.618) % 1)));
      _p.set(sraw[i * 6], sraw[i * 6 + 1] - 0.3, sraw[i * 6 + 2]);
      _m.compose(_p, _q, _s); m.setMatrixAt(j, _m);
    });
    m.frustumCulled = false; group.add(m);
    return m;
  });

  // Grid for nearby-tree lookups (collision, 16 m cells)
  const cell = 16, grid = new Map();
  for (let i = 0; i < N; i++) {
    const key = Math.floor(inst.x[i] / cell) * 4096 + Math.floor(inst.z[i] / cell);
    (grid.get(key) || grid.set(key, []).get(key)).push(i);
  }
  function near(x, z, r) {
    const out = [];
    for (let gx = Math.floor((x - r) / cell); gx <= Math.floor((x + r) / cell); gx++)
      for (let gz = Math.floor((z - r) / cell); gz <= Math.floor((z + r) / cell); gz++)
        for (const i of grid.get(gx * 4096 + gz) || []) if (Math.hypot(inst.x[i] - x, inst.z[i] - z) < r) out.push(i);
    return out;
  }
  return { group, update, shadowSets, color, N, inst, byKind, near, snags };
}
